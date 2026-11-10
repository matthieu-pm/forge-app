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
