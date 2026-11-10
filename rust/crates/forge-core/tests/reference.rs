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
