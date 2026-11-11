use forge_core::{
    actor::{API_SCOPES, Actor, permissions_to_scopes},
    canonical::{command_input, command_input_hash},
    visibility::{DocumentVisibility, ProjectVisibility, TeamVisibility},
};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActorCase {
    actor: Actor,
    scopes: Vec<bool>,
    can_manage_teams: bool,
    can_read_all_private_teams: bool,
    can_manage_workspace_models: bool,
    teams: Vec<bool>,
    projects: Vec<bool>,
    documents: Vec<bool>,
    document_sharing: Vec<bool>,
}

#[test]
fn authority_and_visibility_match_the_reference_matrix() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../reference-fixtures.json")).unwrap();
    let teams: Vec<TeamVisibility> = serde_json::from_value(fixture["teams"].clone()).unwrap();
    let projects: Vec<ProjectVisibility> =
        serde_json::from_value(fixture["projects"].clone()).unwrap();
    let documents: Vec<DocumentVisibility> =
        serde_json::from_value(fixture["documents"].clone()).unwrap();
    let cases: Vec<ActorCase> = serde_json::from_value(fixture["actorCases"].clone()).unwrap();
    for case in cases {
        let actor = case.actor;
        assert_eq!(
            API_SCOPES
                .iter()
                .map(|scope| actor.has_scope(*scope))
                .collect::<Vec<_>>(),
            case.scopes,
            "{actor:?}"
        );
        assert_eq!(actor.can_manage_teams(), case.can_manage_teams, "{actor:?}");
        assert_eq!(
            actor.can_read_all_private_teams(),
            case.can_read_all_private_teams,
            "{actor:?}"
        );
        assert_eq!(
            actor.can_manage_workspace_models(),
            case.can_manage_workspace_models,
            "{actor:?}"
        );
        assert_eq!(
            teams
                .iter()
                .map(|team| team.visible_to(&actor))
                .collect::<Vec<_>>(),
            case.teams,
            "{actor:?}"
        );
        assert_eq!(
            projects
                .iter()
                .map(|project| project.visible_to(&actor))
                .collect::<Vec<_>>(),
            case.projects,
            "{actor:?}"
        );
        assert_eq!(
            documents
                .iter()
                .map(|document| document.visible_to(&actor))
                .collect::<Vec<_>>(),
            case.documents,
            "{actor:?}"
        );
        assert_eq!(
            documents
                .iter()
                .map(|document| document.can_share_with_workspace(&actor))
                .collect::<Vec<_>>(),
            case.document_sharing,
            "{actor:?}"
        );
    }
}

#[test]
fn canonical_json_and_receipt_hashes_match_javascript() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../reference-fixtures.json")).unwrap();
    for case in fixture["canonical"].as_array().unwrap() {
        assert_eq!(
            command_input(&case["value"]),
            case["serialized"].as_str().unwrap()
        );
        assert_eq!(
            command_input_hash(&case["value"]),
            case["hash"].as_str().unwrap()
        );
    }
}

#[test]
fn permission_parsing_preserves_scope_order_and_duplicates() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../reference-fixtures.json")).unwrap();
    for case in fixture["permissions"].as_array().unwrap() {
        assert_eq!(
            serde_json::to_value(permissions_to_scopes(&case["value"])).unwrap(),
            case["scopes"]
        );
    }
}

#[test]
fn feature_ceilings_and_rollouts_match_the_reference() {
    use forge_core::features::{FeatureRollouts, ProductFeature};
    let fixture: Value =
        serde_json::from_str(include_str!("../../../reference-fixtures.json")).unwrap();
    for configuration in fixture["features"].as_array().unwrap() {
        let parsed = FeatureRollouts::parse(configuration["raw"].as_str());
        assert_eq!(parsed.is_ok(), configuration["valid"].as_bool().unwrap());
        let rollouts = parsed.unwrap_or_default();
        for case in configuration["cases"].as_array().unwrap() {
            let feature: ProductFeature = serde_json::from_value(case["feature"].clone()).unwrap();
            assert_eq!(
                serde_json::to_value(rollouts.mode(
                    feature,
                    case["workspaceId"].as_str().unwrap(),
                    case["billing"].as_bool().unwrap()
                ))
                .unwrap(),
                case["mode"]
            );
        }
    }
}

#[test]
fn independent_journal_signatures_and_validation_match_the_reference() {
    use forge_core::journal::{JournalRecord, JournalSource, RecoveryEvent};
    let fixture: Value =
        serde_json::from_str(include_str!("../../../reference-fixtures.json")).unwrap();
    let journal = &fixture["journal"];
    let source: JournalSource = serde_json::from_value(journal["source"].clone()).unwrap();
    assert_eq!(
        source.digest().unwrap(),
        journal["sourceDigest"].as_str().unwrap()
    );
    let key = hex::decode(journal["keyHex"].as_str().unwrap()).unwrap();
    for signed in journal["signed"].as_array().unwrap() {
        let record = JournalRecord::verify(signed.clone(), &key).unwrap();
        assert_eq!(record.signed(&key).unwrap(), *signed);
        if record.events.is_some() {
            let mut equivalent = record.clone();
            equivalent.at = "2026-11-10T12:00:02.000Z".into();
            equivalent.events.as_mut().unwrap()[0]
                .patch
                .as_mut()
                .unwrap()
                .insert("version".into(), serde_json::json!(1.0));
            assert!(record.same_effect_as(&equivalent).unwrap());
            equivalent.at = record.at.clone();
            assert_eq!(
                equivalent.signed(&key).unwrap()["signature"],
                signed["signature"]
            );
        }
        let mut tampered = signed.clone();
        tampered["at"] = serde_json::json!("2026-11-10T12:00:01.000Z");
        assert!(JournalRecord::verify(tampered, &key).is_err());
    }
    for case in journal["events"].as_array().unwrap() {
        let valid = serde_json::from_value::<RecoveryEvent>(case["value"].clone())
            .is_ok_and(|event| event.validate().is_ok());
        assert_eq!(valid, case["valid"].as_bool().unwrap(), "{}", case["value"]);
    }
    for case in journal["sources"].as_array().unwrap() {
        let valid = serde_json::from_value::<JournalSource>(case["value"].clone())
            .is_ok_and(|source| source.validate().is_ok());
        assert_eq!(valid, case["valid"].as_bool().unwrap());
    }
}

#[test]
fn workspace_security_matches_reference_policies_and_entitlements() {
    use forge_core::security::*;
    use std::collections::HashMap;
    let fixture: Value =
        serde_json::from_str(include_str!("../../../reference-fixtures.json")).unwrap();
    let fixture = &fixture["security"];
    assert_eq!(
        serde_json::to_value(SecuritySettings::default()).unwrap(),
        fixture["defaults"]
    );
    let actions: Vec<SecurityAction> = serde_json::from_value(fixture["actions"].clone()).unwrap();
    for case in fixture["policies"].as_array().unwrap() {
        let actor: Actor = serde_json::from_value(case["actor"].clone()).unwrap();
        let settings: SecuritySettings = serde_json::from_value(case["settings"].clone()).unwrap();
        let actual: Vec<_> = actions
            .iter()
            .map(|action| settings.allows(&actor, *action))
            .collect();
        assert_eq!(
            serde_json::to_value(actual).unwrap(),
            case["allowed"],
            "{case}"
        );
    }
    for case in fixture["entitlements"].as_array().unwrap() {
        let plan: WorkspacePlan = serde_json::from_value(case["plan"].clone()).unwrap();
        let overrides: HashMap<_, _> = case["overrides"]
            .as_object()
            .unwrap()
            .iter()
            .filter_map(|(k, v)| {
                Some((
                    serde_json::from_value::<SecurityFeature>(Value::String(k.clone())).ok()?,
                    v.as_bool()?,
                ))
            })
            .collect();
        assert_eq!(
            serde_json::to_value(entitlements(plan, &overrides)).unwrap(),
            case["expected"]
        );
    }
    for case in fixture["domains"].as_array().unwrap() {
        assert_eq!(
            serde_json::to_value(normalized_domain(case["input"].as_str().unwrap())).unwrap(),
            case["expected"],
            "{case}"
        );
    }
}

#[test]
fn subscription_access_matches_reference_at_payment_and_expiry_boundaries() {
    use forge_core::subscription::{SubscriptionState, subscription_access};
    let fixture: Value =
        serde_json::from_str(include_str!("../../../reference-fixtures.json")).unwrap();
    for case in fixture["security"]["subscriptions"].as_array().unwrap() {
        let state = SubscriptionState::from_json(case["state"].clone());
        let now = serde_json::from_value(case["now"].clone()).ok();
        assert_eq!(
            serde_json::to_value(subscription_access(state.as_ref(), now)).unwrap(),
            case["expected"],
            "{case}"
        );
    }
}

#[test]
fn team_input_normalization_and_default_catalog_match_reference() {
    use forge_core::teams::{CreateTeam, TeamSettings, slugify_team_name};
    let fixture: Value =
        serde_json::from_str(include_str!("../../../reference-fixtures.json")).unwrap();
    let cases = &fixture["teamContracts"];
    for case in cases["create"].as_array().unwrap() {
        let result = CreateTeam::parse(case["input"].clone());
        assert_eq!(result.is_ok(), case["valid"].as_bool().unwrap(), "{case}");
        if let Ok(value) = result {
            assert_eq!(
                serde_json::to_value(value).unwrap(),
                case["expected"],
                "{case}"
            );
        }
    }
    for case in cases["settings"].as_array().unwrap() {
        let result = TeamSettings::parse(case["input"].clone());
        assert_eq!(result.is_ok(), case["valid"].as_bool().unwrap(), "{case}");
        if let Ok(value) = result {
            assert_eq!(
                serde_json::to_value(value).unwrap(),
                case["expected"],
                "{case}"
            );
        }
    }
    for case in cases["slugs"].as_array().unwrap() {
        assert_eq!(
            slugify_team_name(case["input"].as_str().unwrap()),
            case["expected"].as_str().unwrap()
        );
    }
    let defaults: Value =
        serde_json::from_str(include_str!("../data/issue-definitions.json")).unwrap();
    assert_eq!(defaults, cases["defaults"]);
}

#[test]
fn issue_definition_validation_and_transition_rules_match_the_reference() {
    use forge_core::definitions::DefinitionValue;
    let fixture: Value =
        serde_json::from_str(include_str!("../../../reference-fixtures.json")).unwrap();
    for (i, case) in fixture["definitionCases"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        let result = DefinitionValue::parse(case["input"].clone());
        assert_eq!(
            result.is_ok(),
            case["valid"].as_bool().unwrap(),
            "case {i}: {}",
            case["input"]
        );
        if let Ok(value) = result {
            assert_eq!(value.into_value(), case["expected"], "case {i}");
        }
    }
    for case in fixture["transitionCases"].as_array().unwrap() {
        let mut value = DefinitionValue::defaults().into_value();
        value["transitions"] = case["rules"].clone();
        let value = DefinitionValue::parse(value).unwrap();
        assert_eq!(
            value.can_transition(case["from"].as_str().unwrap(), case["to"].as_str().unwrap()),
            case["allowed"].as_bool().unwrap()
        );
    }
}

#[test]
fn issue_planning_and_discussion_contracts_match_reference_documents() {
    use forge_core::{comments as c, issues as i, planning as p};
    let fixture: Value =
        serde_json::from_str(include_str!("../../../reference-fixtures.json")).unwrap();
    for (index, case) in fixture["issueCases"].as_array().unwrap().iter().enumerate() {
        let v = case["input"].clone();
        let result = match case["kind"].as_str().unwrap() {
            "draft" => i::draft(v, false),
            "issue" => i::team_issue(v),
            "create" => i::CreateIssue::parse(v).map(i::CreateIssue::into_value),
            "edit" => i::EditIssues::parse(v).map(i::EditIssues::into_value),
            "project" => p::project(v),
            "document" => p::document(v),
            "commentDocument" => c::document(v, false),
            "commentDraft" => c::document(v, true),
            "comment" => c::CommentCommand::parse(v).map(c::CommentCommand::into_value),
            "historyQuery" => i::history_query(v),
            "history" => i::history_details(v, true),
            "relationship" => i::relationship_change(v),
            "relationshipQuery" => i::relationship_query(v),
            "relationshipSearch" => i::relationship_search(v),
            "engagement" => i::engagement(v),
            "lifecycle" => i::lifecycle(v),
            "inactive" => i::inactive_query(v),
            kind => panic!("Missing contract {kind}"),
        };
        assert_eq!(
            result.is_ok(),
            case["valid"].as_bool().unwrap(),
            "case {index}: {case}, error={:?}",
            result.as_ref().err()
        );
        if let Ok(value) = result {
            assert_eq!(value, case["expected"], "case {index}: {}", case["kind"]);
        }
    }
    for case in fixture["issuePure"]["legacy"].as_array().unwrap() {
        assert_eq!(
            i::legacy_source(&case["draft"], case.get("assignee")).unwrap(),
            case["expected"]
        );
    }
    for case in fixture["issuePure"]["comments"].as_array().unwrap() {
        assert_eq!(c::plain_text(&case["doc"]), case["plain"].as_str().unwrap());
        assert_eq!(serde_json::json!(c::mention_ids(&case["doc"])), case["ids"]);
    }
    for case in fixture["issuePure"]["links"].as_array().unwrap() {
        assert_eq!(
            c::safe_link(&case["value"]),
            case["valid"].as_bool().unwrap()
        );
    }
    for case in fixture["issuePure"]["subscribers"].as_array().unwrap() {
        assert_eq!(
            serde_json::json!(i::subscriber_ids(case["value"].as_str().unwrap())),
            case["expected"]
        );
    }
}

#[test]
fn issue_query_validation_normalization_and_cursor_bindings_match_reference() {
    use forge_core::issue_query::IssueQuery;
    let fixture: Value =
        serde_json::from_str(include_str!("../../../reference-fixtures.json")).unwrap();
    for (index, case) in fixture["issueQueries"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        let result = IssueQuery::parse(case["input"].clone());
        assert_eq!(
            result.is_ok(),
            case["valid"].as_bool().unwrap(),
            "case {index}: {case}"
        );
        if let Ok(query) = result {
            assert_eq!(query.as_value(), &case["expected"], "case {index}");
            let actor = serde_json::from_value(case["actor"].clone()).unwrap();
            assert_eq!(
                query.binding(&actor),
                case["binding"].as_str().unwrap(),
                "binding case {index}"
            );
        }
    }
}

#[test]
fn shared_cycle_calendars_settings_and_timezone_names_match_reference() {
    use forge_core::cycles as c;
    let f: Value = serde_json::from_str(include_str!("../../../reference-fixtures.json")).unwrap();
    for (i, case) in f["cycleCases"].as_array().unwrap().iter().enumerate() {
        let input = case["input"].clone();
        let result = match case["kind"].as_str().unwrap() {
            "timezone" => c::timezone(input),
            "settings" => c::Settings::parse(input).map(c::Settings::into_value),
            "triage" => c::triage(input),
            _ => unreachable!(),
        };
        assert_eq!(
            result.is_ok(),
            case["valid"].as_bool().unwrap(),
            "case {i}: {case}"
        );
        if let Ok(value) = result {
            assert_eq!(value, case["expected"], "case {i}: {case}");
        }
    }
    for case in f["cycleCalendar"]["today"].as_array().unwrap() {
        let now = chrono::DateTime::parse_from_rfc3339(case["now"].as_str().unwrap())
            .unwrap()
            .with_timezone(&chrono::Utc);
        assert_eq!(
            c::today(case["zone"].as_str().unwrap(), now).unwrap(),
            case["expected"]
        );
    }
    for case in f["cycleCalendar"]["add"].as_array().unwrap() {
        assert_eq!(
            c::add_days(
                case["date"].as_str().unwrap(),
                case["days"].as_i64().unwrap()
            )
            .unwrap(),
            case["expected"]
        );
    }
    for case in f["cycleCalendar"]["next"].as_array().unwrap() {
        assert_eq!(
            c::next_date(
                case["date"].as_str().unwrap(),
                case["weekday"].as_u64().unwrap() as u32,
                case["strict"].as_bool().unwrap()
            )
            .unwrap(),
            case["expected"]
        );
    }
}

#[test]
fn canonical_project_contracts_catalogs_and_content_match_reference() {
    use forge_core::projects as p;
    let f: Value = serde_json::from_str(include_str!("../../../reference-fixtures.json")).unwrap();
    for (i, c) in f["projectCases"].as_array().unwrap().iter().enumerate() {
        let v = c["input"].clone();
        let result = match c["kind"].as_str().unwrap() {
            "changes" => p::changes(v),
            "fields" => p::fields(v, false, true),
            "statuses" => p::statuses(v),
            "labels" => p::labels(v, false),
            _ => unreachable!(),
        };
        assert_eq!(
            result.is_ok(),
            c["valid"],
            "project contract {i}: {result:?}"
        );
        if let Ok(value) = result {
            assert_eq!(value, c["expected"], "project contract {i}");
        }
    }
    for c in f["projectDates"].as_array().unwrap() {
        let value =
            p::target_day(c["value"].as_str().unwrap()).map(|v| v.format("%Y-%m-%d").to_string());
        assert_eq!(serde_json::json!(value), c["expected"]);
    }
    for (i, c) in f["projectContent"].as_array().unwrap().iter().enumerate() {
        let actor = serde_json::from_value(c["actor"].clone()).unwrap();
        let result = p::reconcile(
            &actor,
            c["before"].as_array().unwrap(),
            c["submitted"].as_array().unwrap(),
            "2026-11-11T00:00:00.000Z",
        );
        assert_eq!(result.is_ok(), c["valid"], "post {i}: {result:?}");
        if let Ok(v) = result {
            assert_eq!(serde_json::json!(v), c["expected"], "post {i}");
        }
    }
    for c in f["projectMilestones"].as_array().unwrap() {
        assert_eq!(
            p::unique_milestones(c["value"].as_array().unwrap()).is_ok(),
            c["valid"]
        );
    }
}

#[test]
fn initiative_contracts_and_settings_match_reference() {
    use forge_core::initiatives as i;
    let f: Value = serde_json::from_str(include_str!("../../../reference-fixtures.json")).unwrap();
    for (n, c) in f["initiativeCases"].as_array().unwrap().iter().enumerate() {
        let v = c["input"].clone();
        let result = match c["kind"].as_str().unwrap() {
            "changes" => i::changes(v),
            "fields" => i::fields(v, false, true),
            "initiative" => i::initiative(v),
            "settings" => i::settings(v),
            _ => unreachable!(),
        };
        assert_eq!(
            result.is_ok(),
            c["valid"],
            "initiative case {n}: {result:?}"
        );
        if let Ok(v) = result {
            assert_eq!(v, c["expected"], "initiative case {n}");
        }
    }
}

#[test]
fn documents_match_closed_content_commands_and_lossless_legacy_recovery() {
    use forge_core::documents as d;
    use serde_json::json;
    let fixtures: Value =
        serde_json::from_str(include_str!("../../../reference-fixtures.json")).unwrap();
    let f = &fixtures["documentContracts"];
    for (i, c) in f["cases"].as_array().unwrap().iter().enumerate() {
        let v = c["input"].clone();
        let result = match c["kind"].as_str().unwrap() {
            "body" => d::body(v),
            "fields" => d::fields(v),
            "source" => d::source(v),
            "command" => d::command(v),
            _ => unreachable!(),
        };
        assert_eq!(result.is_ok(), c["valid"], "document case {i}: {result:?}");
        if let Ok(value) = result {
            assert_eq!(value, c["expected"], "document case {i}");
            if c["kind"] == "body" {
                assert_eq!(d::plain_text(&value), c["plain"], "document text {i}");
            }
        }
    }
    for c in f["stress"].as_array().unwrap() {
        let n = c["count"].as_u64().unwrap() as usize;
        let body = match c["kind"].as_str().unwrap() {
            "depth" => {
                let mut node = json!({"type":"paragraph"});
                for _ in 1..n {
                    node = json!({"type":"blockquote","content":[node]});
                }
                json!({"type":"doc","content":[node]})
            }
            "nodes" => json!({"type":"doc","content":vec![json!({"type":"paragraph"});n]}),
            "size" => {
                json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"a".repeat(n)}]}]})
            }
            _ => unreachable!(),
        };
        let raw = serde_json::to_string(&body).unwrap();
        assert_eq!(forge_core::json::parse(&raw).unwrap(), body);
        assert_eq!(d::body(body).is_ok(), c["valid"], "document boundary {c}");
    }
    for c in f["features"].as_array().unwrap() {
        assert_eq!(
            d::feature_enabled(&c["env"], "FORGE_SHARED_DOCUMENTS_ENABLED"),
            c["expected"]
        );
    }
    for c in f["matches"].as_array().unwrap() {
        assert_eq!(
            d::matches_legacy(&c["resource"], &c["fields"], c["kind"].as_str().unwrap()),
            c["expected"],
            "legacy {c}"
        );
    }
    for c in f["retained"].as_array().unwrap() {
        let ids = c["ids"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_owned())
            .collect();
        let result = d::retain_copies(c["value"].as_str(), c["previous"].as_str(), &ids);
        assert_eq!(result.is_ok(), c["valid"], "retention {c}");
        if let Ok(value) = result {
            assert_eq!(json!(value), c["expected"]);
        }
    }
}

#[test]
fn bounded_json_accepts_supported_nesting_and_rejects_excess_and_trailing_data() {
    for count in [128, 256, 257] {
        let raw = format!("{}0{}", "[".repeat(count), "]".repeat(count));
        assert_eq!(forge_core::json::parse(&raw).is_ok(), count <= 256);
    }
    for raw in ["{} {}", "[}", "[", "\"unterminated", "{\"a\": NaN}"] {
        assert!(forge_core::json::parse(raw).is_err());
    }
    let raw = serde_json::to_string(&"[\\\"".repeat(300)).unwrap();
    assert!(forge_core::json::parse(&raw).is_ok());
}

#[test]
fn saved_views_resource_boards_and_project_queries_match_source() {
    use forge_core::{saved_views as v, team_resources as r};
    let fixtures: Value =
        serde_json::from_str(include_str!("../../../reference-fixtures.json")).unwrap();
    let f = &fixtures["viewContracts"];
    for (i, c) in f["cases"].as_array().unwrap().iter().enumerate() {
        let input = c["input"].clone();
        let result = match c["kind"].as_str().unwrap() {
            "definition" => v::definition(input),
            "mutation" => v::mutation(input),
            "resources" => r::fields(input),
            "resourceCommand" => r::command(input),
            _ => unreachable!(),
        };
        assert_eq!(
            result.is_ok(),
            c["valid"],
            "view/resource case {i}: {result:?}"
        );
        if let Ok(value) = result {
            assert_eq!(value, c["expected"], "view/resource case {i}");
        }
    }
    for c in f["urls"].as_array().unwrap() {
        assert_eq!(
            serde_json::json!(r::url(c["raw"].as_str().unwrap())),
            c["expected"],
            "URL {c}"
        );
    }
    for (i, c) in f["projects"].as_array().unwrap().iter().enumerate() {
        assert_eq!(
            serde_json::json!(
                v::visible_projects(c["catalog"].as_array().unwrap(), &c["definition"]).unwrap()
            ),
            c["expected"],
            "project query {i}"
        );
    }
}

#[test]
fn product_state_and_retained_copy_protocols_match_source() {
    use forge_core::product_state::{self as p, copies as c};
    let fixtures: Value =
        serde_json::from_str(include_str!("../../../reference-fixtures.json")).unwrap();
    let f = &fixtures["stateContracts"];
    for case in f["commands"].as_array().unwrap() {
        let result = p::command(case["input"].clone());
        assert_eq!(result.is_ok(), case["valid"]);
        if let Ok(v) = result {
            assert_eq!(v, case["expected"]);
        }
    }
    for case in f["keys"].as_array().unwrap() {
        let key = case["key"].as_str().unwrap();
        assert_eq!(p::product_key(key), case["product"]);
        assert_eq!(c::issue_key(key), case["issueCopy"]);
        assert_eq!(serde_json::json!(p::feature(key)), case["feature"]);
    }
    for (i, case) in f["copies"].as_array().unwrap().iter().enumerate() {
        let key = case["key"].as_str().unwrap();
        let value = case["value"].as_str();
        let mut keep = |id: &str| case["keep"].as_array().unwrap().iter().any(|v| v == id);
        let result = match case["kind"].as_str().unwrap() {
            "issueRead" | "issueScrub" => c::filter_issue(
                key,
                value,
                &mut keep,
                0,
                if case["kind"] == "issueRead" {
                    c::Mode::Read
                } else {
                    c::Mode::Scrub
                },
            )
            .map(|v| serde_json::json!(v)),
            "issueIds" => c::issue_ids(key, value).map(|v| serde_json::json!(v)),
            "project" => c::filter_project(key, value, &mut keep, 0).map(|v| serde_json::json!(v)),
            "projectIds" => c::project_ids(key, value).map(|v| serde_json::json!(v)),
            _ => unreachable!(),
        };
        assert_eq!(result.is_ok(), case["valid"], "copy {i}: {result:?}");
        if let Ok(v) = result {
            assert_eq!(v, case["expected"], "copy {i}");
        }
    }
    for (i, case) in f["retained"].as_array().unwrap().iter().enumerate() {
        let key = case["key"].as_str().unwrap();
        let ids = case["retained"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_owned())
            .collect();
        let result = c::retain_hidden(
            key,
            case["incoming"].as_str(),
            case["previous"].as_str(),
            &ids,
            0,
        )
        .and_then(|value| {
            c::retained_command(key, case["previous"].as_str(), &ids, 0)
                .map(|command| (value, command))
        });
        assert_eq!(result.is_ok(), case["valid"], "retention {i}: {result:?}");
        if let Ok((v, command)) = result {
            assert_eq!(serde_json::json!(v), case["expected"], "retention {i}");
            assert_eq!(command, case["command"], "retention command {i}");
        }
    }
}

#[test]
fn preference_contracts_decoding_and_reviewed_imports_match_source() {
    use forge_core::preferences::{self as p, imports as i};
    let fixtures: Value =
        serde_json::from_str(include_str!("../../../reference-fixtures.json")).unwrap();
    let f = &fixtures["preferenceContracts"];
    for c in f["fields"].as_array().unwrap() {
        let v = p::field(
            c["scope"].as_str().unwrap(),
            c["key"].as_str().unwrap(),
            c["value"].clone(),
            false,
        );
        assert_eq!(v.is_ok(), c["valid"], "field {c}");
        if let Ok(v) = v {
            assert_eq!(v, c["expected"], "field {c}")
        }
    }
    for c in f["commands"].as_array().unwrap() {
        let v = p::command(c["input"].clone());
        assert_eq!(v.is_ok(), c["valid"], "command {c}");
        if let Ok(v) = v {
            assert_eq!(v, c["expected"], "command {c}")
        }
    }
    for c in f["decode"].as_array().unwrap() {
        assert_eq!(
            p::decode(
                c["scope"].as_str().unwrap(),
                c["kind"]
                    .as_str()
                    .map(|k| (k, c["resource"].as_str().unwrap())),
                &c["values"]
            )
            .unwrap(),
            c["expected"],
            "decode {c}"
        )
    }
    for c in f["prefix"].as_array().unwrap() {
        assert_eq!(
            format!(
                "teamIssues.{}",
                p::encode_resource(c["resource"].as_str().unwrap())
            ),
            c["expected"]
        )
    }
    for c in f["inspect"].as_array().unwrap() {
        assert_eq!(
            i::inspect(&c["source"], c["user"].as_str().unwrap()),
            c["expected"],
            "inspect {c}"
        );
        assert_eq!(i::fingerprint(&c["source"]), c["fingerprint"])
    }
    for c in f["plans"].as_array().unwrap() {
        let v = i::validate(c["input"].clone());
        assert_eq!(v.is_ok(), c["valid"], "plan {c}");
        if let Ok(v) = v {
            assert_eq!(v, c["expected"], "plan {c}")
        }
    }
}

#[test]
fn legacy_import_manifests_and_files_match_source_inventory() {
    use forge_core::imports as i;
    let fixture: Value =
        serde_json::from_str(include_str!("../../../reference-fixtures.json")).unwrap();
    let f = &fixture["importContracts"];
    for c in f["requests"].as_array().unwrap() {
        let result = i::request(c["input"].clone(), c["kind"].as_str().unwrap());
        assert_eq!(result.is_ok(), c["valid"], "request {c}");
        if let Ok(v) = result {
            assert_eq!(v, c["expected"], "request {c}")
        }
    }
    for c in f["files"].as_array().unwrap() {
        let result = i::validated_files(c["input"].as_array().unwrap());
        assert_eq!(result.is_ok(), c["valid"], "files {c}");
        if let Ok(v) = result {
            assert_eq!(serde_json::json!(v), c["expected"], "files {c}")
        }
    }
    fn comparable(mut value: Value) -> Value {
        // Validation diagnostics differ from Zod's serialized exception format. Keep
        // all source identities, effects, exclusions, quarantine states and payloads.
        for e in value["entries"].as_array_mut().unwrap() {
            if let Some(message) = e.as_object_mut().unwrap().remove("message") {
                assert!(!message.as_str().unwrap().is_empty());
            }
        }
        for exclusion in value["exclusions"].as_array_mut().unwrap() {
            let s = exclusion.as_str().unwrap();
            if s.ends_with(" Exact bytes preserved.") {
                *exclusion = serde_json::json!(format!(
                    "{}: Source parse failed. Exact bytes preserved.",
                    s.split(": ").next().unwrap()
                ))
            }
        }
        value
    }
    for (index, c) in f["manifests"].as_array().unwrap().iter().enumerate() {
        let input = &c["input"];
        let sources = serde_json::from_value::<Vec<i::Source>>(input["sources"].clone()).unwrap();
        let modules = input
            .get("modules")
            .map(|v| serde_json::from_value(v.clone()).unwrap());
        let actual = i::build(
            input["id"].as_str().unwrap(),
            input["actorId"].as_str().unwrap(),
            input["workspaceId"].as_str().unwrap(),
            &sources,
            input["defaultStatus"].as_str().unwrap(),
            modules,
            c["now"].as_str().unwrap(),
        )
        .unwrap();
        assert_eq!(
            comparable(actual),
            comparable(c["expected"].clone()),
            "manifest {index}"
        );
    }
}

#[test]
fn legacy_import_checkpoints_and_reference_selection_match_source() {
    use forge_core::imports::checkpoint as c;
    let fixture: Value =
        serde_json::from_str(include_str!("../../../reference-fixtures.json")).unwrap();
    for (i, case) in fixture["importContracts"]["checkpoints"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        assert_eq!(
            forge_core::json::parse(&c::encode(&case["input"])).unwrap(),
            case["encoded"],
            "checkpoint {i}"
        );
        assert_eq!(
            c::snapshot(&case["input"], false),
            case["snapshot"],
            "snapshot {i}"
        );
        assert_eq!(
            c::snapshot(&case["input"], true),
            case["filesSnapshot"],
            "files {i}"
        );
        let deps: Vec<_> = case["input"]["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(c::content_dependencies)
            .collect();
        assert_eq!(
            serde_json::json!(deps),
            case["dependencies"],
            "dependencies {i}"
        );
    }
    for case in fixture["importContracts"]["references"].as_array().unwrap() {
        assert_eq!(
            serde_json::json!(c::references(
                &case["manifest"],
                &case["entry"],
                case["kind"].as_str().unwrap(),
                case["legacyId"].as_str().unwrap()
            )),
            case["expected"],
            "references {case}"
        );
    }
}

#[test]
fn file_contracts_grants_and_stream_verification_match_source() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    use forge_core::files as f;
    let fixture: Value =
        serde_json::from_str(include_str!("../../../reference-fixtures.json")).unwrap();
    let cases = &fixture["fileContracts"];
    for (i, c) in cases["schemas"].as_array().unwrap().iter().enumerate() {
        let input = c["input"].clone();
        let result = match c["kind"].as_str().unwrap() {
            "upload" => f::upload_input(input),
            "target" => f::upload_target(input),
            "resource" => f::resource_target(input),
            "delivery" => f::delivery_target(input),
            "ready" => f::ready_upload(input),
            "resource-input" => f::resource_input(input),
            _ => panic!("schema"),
        };
        assert_eq!(result.is_ok(), c["valid"], "schema {i}: {c}");
        if let Ok(v) = result {
            assert_eq!(v, c["expected"], "schema {i}");
        }
    }
    for c in cases["references"].as_array().unwrap() {
        assert_eq!(
            f::reference(c["input"].as_str().unwrap()),
            c["valid"],
            "reference {c}"
        );
    }
    for (i, c) in cases["grants"].as_array().unwrap().iter().enumerate() {
        let actor = serde_json::from_value(c["actor"].clone()).unwrap();
        let secret = c["secret"].as_str().unwrap();
        let token = c["token"].as_str().unwrap();
        let purpose = c["purpose"].as_str().unwrap();
        let now = c["now"].as_i64().unwrap();
        if c["mint"] == true {
            assert_eq!(
                f::grants::mint(secret, &actor, &c["target"], purpose, now).unwrap(),
                token,
                "mint {i}"
            );
        }
        assert_eq!(
            f::grants::verify(secret, token, &actor, &c["target"], purpose, now).is_ok(),
            c["valid"],
            "verify {i}: {c}"
        );
    }
    for (i, c) in cases["verification"].as_array().unwrap().iter().enumerate() {
        let bytes = STANDARD.decode(c["bytes"].as_str().unwrap()).unwrap();
        let result = (|| {
            let mut v = f::verification::Verification::new(&c["input"])?;
            for bytes in bytes.chunks(c["chunkSize"].as_u64().unwrap() as usize) {
                v.push(bytes)?;
            }
            v.finish()?.metadata(c["detected"].as_str())
        })();
        match result {
            Ok(metadata) => {
                assert!(c["error"].is_null(), "verification {i}: {c}");
                assert_eq!(metadata, c["output"], "verification {i}");
            }
            Err(error) => {
                assert_eq!(error.code(), c["error"]["code"], "verification {i}: {c}");
                assert_eq!(
                    error.to_string(),
                    c["error"]["message"],
                    "verification {i}: {c}"
                );
            }
        }
    }
}
