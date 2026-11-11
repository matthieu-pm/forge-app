use super::*;
use crate::{documents, initiatives, preferences, saved_views, team_resources};
impl Builder<'_> {
    fn add(
        &mut self,
        kind: &str,
        path: &str,
        raw: &Value,
        team: &str,
        parse: impl FnOnce(&Value) -> Result<Value>,
    ) {
        let (key, checksum) = (self.key, self.checksum);
        let value = object(raw);
        let scope = if kind == "milestone" {
            path.split("/milestones/").next().unwrap_or(path)
        } else {
            team
        };
        let mut entry = json!({"id":hash(&json!([key,checksum,path])),"sourceKey":key,"sourceChecksum":checksum,"path":path,"legacyId":value["id"].as_str().unwrap_or(""),"kind":kind,"teamId":team,"fingerprint":hash(&json!({"raw":raw,"kind":kind,"scope":scope})),"title":string(nullish(&value,"name",nullish(&value,"title",&json!("Invalid source record")))),"files":[],"state":"pending","sourceValid":true});
        let parsed = (|| -> Result<()> {
            c::text(entry["legacyId"].clone(), 1, 255, false)?;
            let content = parse(&value)?;
            entry["content"] = content.clone();
            let scope = if ["milestone", "document"].contains(&kind) {
                content["projectId"].as_str().unwrap_or(team)
            } else {
                team
            };
            entry["fingerprint"] = json!(hash(&json!({"raw":raw,"kind":kind,"scope":scope})));
            if kind == "milestone"
                || (kind == "document" && crate::comments::truthy(&content["projectId"]))
            {
                entry["legacyId"] = json!(format!(
                    "{}::{}",
                    text(&content, "projectId"),
                    text(&entry, "legacyId")
                ))
            }
            if kind == "milestone" {
                let mut aliases = vec![content["fields"]["name"].clone()];
                aliases.extend(array(content["fields"].get("aliases"))?.to_vec());
                entry["legacyAliases"] = json!(
                    aliases
                        .into_iter()
                        .map(|a| format!("{}::{}", text(&content, "projectId"), string(&a)))
                        .collect::<Vec<_>>()
                )
            }
            if kind == "resource" {
                entry["legacyId"] = json!(format!(
                    "{}:{}",
                    if has(&content["fields"], "name") {
                        "section"
                    } else {
                        "link"
                    },
                    text(&entry, "legacyId")
                ))
            }
            if has(&value, "revision") {
                entry["canonicalProjection"] = json!(true);
                entry["canonicalId"] = c::uuid(value["id"].clone())?;
                entry["reviewRequired"] = json!(true)
            }
            if kind == "view" {
                entry["teamId"] = content["definition"]
                    .get("teamId")
                    .cloned()
                    .unwrap_or(json!(""))
            }
            Ok(())
        })();
        if let Err(error) = parsed {
            entry["sourceValid"] = json!(false);
            entry["state"] = json!("quarantined");
            entry["message"] = json!(if error.0.starts_with("Invalid value for ") {
                "This record has invalid content or sharing settings. Its original source is retained for review.".into()
            } else {
                error.0
            })
        }
        self.entries.push(entry)
    }
}
struct Builder<'a> {
    key: &'a str,
    checksum: &'a str,
    modules: Modules,
    entries: Vec<Value>,
    exclusions: Vec<String>,
}
impl Builder<'_> {
    fn resource(&mut self, raw: &Value, path: &str, team: &str, project: Option<&str>) {
        let value = object(raw);
        let link = value["kind"] == "link" || value["url"].is_string();
        if link && project.is_some_and(|s| !s.is_empty()) {
            self.exclusions.push(format!(
                "{}/{path}: project links remain preserved; no canonical project-link module.",
                self.key
            ));
            return;
        }
        if !(if link {
            self.modules.resources
        } else {
            self.modules.documents
        }) {
            self.exclusions.push(format!(
                "{}/{path}: content module is disabled; exact source retained.",
                self.key
            ));
            return;
        }
        self.add(
            if link { "resource" } else { "document" },
            path,
            raw,
            team,
            |v| {
                if v.get("visibility").is_some_and(|x| {
                    x != if project.is_some_and(|s| !s.is_empty()) {
                        "project"
                    } else {
                        "team"
                    }
                }) || v["sharedWithWorkspace"] == true
                    || v.get("teamId").is_some_and(|x| x != team)
                    || v.get("projectId")
                        .is_some_and(|x| Some(x.as_str().unwrap_or("\0")) != project)
                {
                    return Err(fail(
                        "Resource sharing scope is ambiguous; original retained for review.",
                    ));
                }
                let section = v
                    .get("sectionId")
                    .map(|v| c::nullable(v.clone(), c::string))
                    .transpose()?;
                let mut content = if link {
                    let raw = c::string(nullish(v, "url", &v["content"]).clone())?;
                    let url = team_resources::url(raw.as_str().unwrap())
                        .ok_or_else(|| fail("Invalid resource URL."))?;
                    json!({"kind":"resource","fields":{"title":c::text(v["title"].clone(),1,200,true)?,"url":url}})
                } else {
                    if v.get("kind").is_some_and(|k| k != "document") {
                        return Err(fail("Unknown resource kind."));
                    }
                    let text =
                        c::text(nullish(v, "content", &json!("")).clone(), 0, 100000, false)?;
                    let body = if v["body"].is_null() {
                        json!({"type":"doc","content":text.as_str().unwrap().split('\n').map(|t|if t.is_empty(){json!({"type":"paragraph"})}else{json!({"type":"paragraph","content":[{"type":"text","text":t}]})}).collect::<Vec<_>>()})
                    } else {
                        v["body"].clone()
                    };
                    let fields = documents::fields(
                        json!({"title":v["title"],"body":body,"icon":nullish(v,"icon",&documents::default_icon()),"sectionId":null}),
                    )?;
                    let mut c = json!({"kind":"document","sourceId":c::text(v["id"].clone(),1,usize::MAX,false)?,"fields":fields});
                    if let Some(project) = project {
                        c["projectId"] = json!(project)
                    }
                    c
                };
                if let Some(section) = section {
                    content["sectionId"] = section
                }
                Ok(content)
            },
        )
    }
}
fn custom_view(v: &Value, actor: &str) -> Result<Value> {
    let mut o = Object::new(
        v.clone(),
        &[
            "id",
            "name",
            "description",
            "icon",
            "ownerId",
            "visibility",
            "teamId",
            "favorite",
            "createdAt",
            "updatedAt",
            "kind",
            "filters",
            "display",
        ],
        false,
    )?;
    for k in ["id", "ownerId"] {
        o.required(k, |v| c::text(v, 1, usize::MAX, false))?;
    }
    o.required("name", |v| c::text(v, 1, 80, true))?;
    o.required("description", |v| c::text(v, 0, 2000, false))?;
    o.required("icon", Ok)?;
    o.required("visibility", |v| {
        c::enumeration(v, &["personal", "workspace", "team"])
    })?;
    o.optional("teamId", |v| c::text(v, 1, usize::MAX, false))?;
    o.required("favorite", c::boolean)?;
    for k in ["createdAt", "updatedAt"] {
        o.required(k, c::datetime)?;
    }
    o.required("kind", |v| c::enumeration(v, &["issues", "projects"]))?;
    let view = o.finish();
    let project = view["kind"] == "projects";
    let schema =
        &preferences::schemas()["workspace"][if project { "projects" } else { "teamIssues" }];
    let display = preferences::parse(
        if project {
            schema
        } else {
            &schema["fields"]["display"]
        },
        view.get("display"),
        false,
    )?
    .ok_or(ContractError("view display"))?;
    let filters_schema = if project {
        &schema["fields"]["views"]["element"]["fields"]["filters"]
    } else {
        &schema["fields"]["filters"]
    };
    let filters = preferences::parse(filters_schema, view.get("filters"), false)?
        .ok_or(ContractError("view filters"))?;
    let mut definition = json!({"version":1,"name":view["name"],"description":view["description"],"icon":view["icon"],"visibility":view["visibility"],"kind":view["kind"],"filters":filters,"display":display});
    if let Some(team) = view.get("teamId") {
        definition["teamId"] = team.clone()
    }
    if project {
        for k in ["favoriteIds", "subscribedIds", "views"] {
            definition["display"][k] = json!([])
        }
    }
    // Normalize the same intermediate saved-view definition before restoring raw
    // filter/display input for the second, strict source boundary.
    let mut definition = saved_views::definition(definition)?;
    if view["ownerId"] != actor {
        return Err(fail(
            "View ownership is ambiguous; original retained for review.",
        ));
    }
    definition["filters"] = v["filters"].clone();
    if project {
        definition["display"].as_object_mut().unwrap().extend(
            c::record(v["display"].clone())?
                .as_object()
                .unwrap()
                .clone(),
        );
        for k in ["favoriteIds", "subscribedIds", "views"] {
            definition["display"][k] = json!([])
        }
    } else {
        definition["display"] = v["display"].clone()
    }
    Ok(saved_views::definition(definition)?)
}
pub fn content_entries(
    key: &str,
    checksum: &str,
    body: &Value,
    actor: &str,
    workspace: &str,
    modules: Modules,
) -> Result<(Vec<Value>, Vec<String>)> {
    let mut b = Builder {
        key,
        checksum,
        modules,
        entries: vec![],
        exclusions: vec![],
    };
    if key == format!("forge:workspace:{workspace}:initiatives:v1") {
        for (i, raw) in array(body.get("initiatives"))?.iter().enumerate() {
            let v = object(raw);
            let path = format!("initiatives/{i}");
            if modules.initiatives {
                b.add("initiative", &path, raw, "", |value| {
                    let mut v = value.clone();
                    for k in ["projects", "resources", "views", "comments", "updates"] {
                        v[k] = json!([])
                    }
                    let mut fields = initiatives::initiative(v)?;
                    if crate::comments::truthy(&fields["description"]) {
                        fields["description"] = documents::body(fields["description"].clone())?
                    }
                    if !array(fields.get("labelIds"))?.is_empty() {
                        return Err(fail("Initiative labels have no enabled canonical adapter."));
                    }
                    let ids = array(value.get("projects"))?
                        .iter()
                        .map(|p| c::text(p["id"].clone(), 1, usize::MAX, false))
                        .collect::<c::Result<Vec<_>>>()?;
                    Ok(json!({"kind":"initiative","fields":fields,"projectIds":ids}))
                })
            } else {
                b.exclusions.push(format!(
                    "{key}/{path}: initiatives module disabled; source retained."
                ))
            }
            if !array(v.get("resources"))?.is_empty() || !array(v.get("views"))?.is_empty() {
                b.exclusions.push(format!("{key}/{path}: initiative resources and views retained until their canonical scope is available."))
            }
        }
        let mut projects: Vec<(String, &Value)> = array(body.get("workspaceProjects"))?
            .iter()
            .enumerate()
            .map(|(i, v)| (format!("workspaceProjects/{i}"), v))
            .collect();
        for (i, raw) in array(body.get("initiatives"))?.iter().enumerate() {
            for (j, p) in array(raw.get("projects"))?.iter().enumerate() {
                projects.push((format!("initiatives/{i}/projects/{j}"), p))
            }
        }
        for (path, raw) in projects {
            let value = object(raw);
            let project = string(nullish(&value, "id", &json!("")));
            let team = value["teamIds"]
                .as_array()
                .and_then(|a| a.first())
                .filter(|v| !v.is_null())
                .map(string)
                .unwrap_or_default();
            for (i, m) in array(value.get("milestones"))?.iter().enumerate() {
                if !modules.milestones {
                    b.exclusions.push(format!(
                        "{key}/{path}/milestones/{i}: milestone module disabled."
                    ));
                    continue;
                }
                b.add(
                    "milestone",
                    &format!("{path}/milestones/{i}"),
                    m,
                    &team,
                    |v| {
                        let mut fields = planning::milestone(v.clone())?;
                        if crate::comments::truthy(&fields["description"]) {
                            fields["description"] = documents::body(fields["description"].clone())?
                        }
                        fields["descriptionHistory"] = json!([]);
                        Ok(json!({"kind":"milestone","projectId":project,"fields":fields}))
                    },
                )
            }
            for (i, r) in array(value.get("resources"))?.iter().enumerate() {
                b.resource(r, &format!("{path}/resources/{i}"), &team, Some(&project))
            }
        }
    } else if regex::Regex::new(r"^forge:team-home:v1:[^:]+$")
        .unwrap()
        .is_match(key)
    {
        let team = key.rsplit(':').next().unwrap();
        for (i, section) in array(body.get("sections"))?.iter().enumerate() {
            if modules.resources {
                b.add(
                    "resource",
                    &format!("sections/{i}"),
                    section,
                    team,
                    |v| {
                        Ok(
                            json!({"kind":"resource","fields":{"name":c::text(v["name"].clone(),1,80,true)?}}),
                        )
                    },
                )
            } else {
                b.exclusions
                    .push(format!("{key}/sections/{i}: resource module disabled."))
            }
        }
        for (i, r) in array(body.get("resources"))?.iter().enumerate() {
            b.resource(r, &format!("resources/{i}"), team, None)
        }
        b.exclusions.push(format!("{key}: loops, favorites, collapsed sections and retained drafts stay in the private source."));
    } else if key == format!("forge:workspace:{workspace}:custom-views:v1:{actor}") {
        if body["version"] != 1 {
            return Err(fail("Unsupported view schema version."));
        }
        for (i, v) in array(body.get("views"))?.iter().enumerate() {
            if !modules.views {
                b.exclusions
                    .push(format!("{key}/views/{i}: saved views module disabled."));
                continue;
            }
            b.add("view", &format!("views/{i}"), v, "", |v| {
                Ok(json!({"kind":"view","definition":custom_view(v,actor)?}))
            })
        }
        b.exclusions.push(format!("{key}: personal favorites, subscriptions and display preferences remain outside shared-content import."));
    }
    Ok((b.entries, b.exclusions))
}
