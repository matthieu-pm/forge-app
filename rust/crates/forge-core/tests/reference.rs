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
