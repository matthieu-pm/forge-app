use serde_json::Value;

fn values(value: &Value) -> Vec<String> {
    if value.is_null() || value.as_str() == Some("") {
        return Vec::new();
    }
    let string = |v: &Value| {
        v.as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| crate::canonical::javascript_stringify(v))
    };
    match value.as_array() {
        Some(a) => a.iter().map(string).collect(),
        None => vec![string(value)],
    }
}
fn selected(selected: &Value, actual: &[String]) -> bool {
    selected.as_array().into_iter().flatten().any(|v| {
        if v == "__none__" {
            actual.is_empty()
        } else {
            v.as_str().is_some_and(|s| actual.iter().any(|a| a == s))
        }
    })
}
/// Receives validated conditions and a normalized entity snapshot.
pub fn matches_conditions(conditions: &[Value], entity: &Value) -> bool {
    fn one(condition: &Value, entity: &Value) -> bool {
        if let Some(children) = condition["conditions"].as_array() {
            return if condition["operator"] == "and" {
                children.iter().all(|c| one(c, entity))
            } else {
                children.iter().any(|c| one(c, entity))
            };
        }
        let actual = values(&entity[condition["field"].as_str().unwrap_or_default()]);
        let includes = selected(&condition["values"], &actual);
        match condition["operator"].as_str() {
            Some("is" | "any") => includes,
            Some("isNot" | "none") => !includes,
            Some("contains") => condition["values"][0].as_str().is_some_and(|needle| {
                actual
                    .iter()
                    .any(|v| v.to_lowercase().contains(&needle.to_lowercase()))
            }),
            _ => false,
        }
    }
    conditions.iter().all(|c| one(c, entity))
}
/// Receives validated fields and a normalized event. Collection qualifiers
/// compare the real difference; the no-value sentinel is never a removed item.
pub fn matches_event(fields: &Value, event: &Value) -> bool {
    let trigger = &fields["trigger"];
    let Some(conditions) = fields["conditions"].as_array() else {
        return false;
    };
    if trigger["kind"] != "event"
        || trigger["entity"] != event["entity"]
        || !matches_conditions(conditions, &event["after"])
    {
        return false;
    }
    match trigger["event"].as_str().unwrap_or_default() {
        "comment" => {
            if event["event"] != "comment" {
                return false;
            }
            match trigger["commentMode"].as_str() {
                Some("newThread") => {
                    event["comment"].is_object()
                        && event["comment"]["parentId"]
                            .as_str()
                            .is_none_or(str::is_empty)
                }
                Some("contains") => event["comment"]["text"].as_str().is_some_and(|s| {
                    s.to_lowercase().contains(
                        &trigger["commentText"]
                            .as_str()
                            .unwrap_or_default()
                            .to_lowercase(),
                    )
                }),
                Some("mentions") => {
                    trigger["mentionIds"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|id| {
                            event["comment"]["mentionIds"]
                                .as_array()
                                .is_some_and(|ids| ids.contains(id))
                        })
                }
                _ => true,
            }
        }
        "triage" => {
            event["after"]["triage"] == true
                && !(event["before"]["triage"] == true
                    && matches_conditions(conditions, &event["before"]))
        }
        "created" | "updated" | "update" | "started" | "completed" => {
            trigger["event"] == event["event"]
        }
        _ => {
            let Some(property) = trigger["property"].as_str() else {
                return false;
            };
            if event["event"] != "updated" || event["before"].is_null() {
                return false;
            }
            let before = values(&event["before"][property]);
            let after = values(&event["after"][property]);
            let unqualified = trigger["values"].as_array().is_none_or(Vec::is_empty);
            if trigger["event"] == "changed" {
                return before != after && (unqualified || selected(&trigger["values"], &after));
            }
            let (from, against) = if trigger["event"] == "added" {
                (&after, &before)
            } else {
                (&before, &after)
            };
            from.iter().filter(|v| !against.contains(v)).any(|v| {
                unqualified
                    || (v != "__none__"
                        && trigger["values"].as_array().is_some_and(|a| {
                            a.iter().any(|s| s != "__none__" && s.as_str() == Some(v))
                        }))
            })
        }
    }
}
