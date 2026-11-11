use crate::{
    auth::{self, AuthError, configuration, cookie_token},
    state::AppState,
};
use axum::{
    Json,
    extract::{Query, State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use forge_core::{
    actor::{Actor, Authentication},
    comments::CommentCommand,
    issues::{CreateIssue, EditIssues},
};
use forge_store::{
    Database, StoreError, authority,
    issues::{self, IssueOptions},
};
use serde::Deserialize;
use serde_json::Value;
pub(crate) struct IssueHttpError(AuthError);
impl From<AuthError> for IssueHttpError {
    fn from(error: AuthError) -> Self {
        Self(error)
    }
}
impl From<StoreError> for IssueHttpError {
    fn from(error: StoreError) -> Self {
        if let StoreError::Planning(message) = &error {
            return Self(AuthError(
                StatusCode::BAD_REQUEST,
                "INVALID_PROJECT",
                message,
            ));
        }
        let message = match &error {
            StoreError::IssueValidation(message) | StoreError::IssueRejected(message) => {
                Some(*message)
            }
            StoreError::Database(sqlx::Error::Database(e)) => match e.constraint() {
                Some("issues_allowed_transition") => {
                    Some("This status transition is not allowed by the team workflow.")
                }
                Some("workspace_active_issue_limit") => {
                    Some("Your workspace has reached its active issue limit.")
                }
                Some(
                    "issues_parent_acyclic"
                    | "issues_not_self_parent"
                    | "issue_relations_blocks_acyclic",
                ) => Some("This relationship would create a cycle. Choose another issue."),
                _ => None,
            },
            _ => None,
        };
        Self(message.map_or_else(
            || AuthError::from(error),
            |message| AuthError(StatusCode::BAD_REQUEST, "INVALID_ISSUE", message),
        ))
    }
}
impl IntoResponse for IssueHttpError {
    fn into_response(self) -> Response {
        self.0.into_response()
    }
}
pub(crate) type Payload = Result<Json<Value>, JsonRejection>;
pub(crate) async fn context<'a>(
    state: &'a AppState,
    headers: &HeaderMap,
    payload: Payload,
) -> Result<(&'a Database, Actor, Value), IssueHttpError> {
    let Json(mut input) = payload.map_err(|_| auth::invalid_body())?;
    let (database, auth) = configuration(state)?;
    let actor = authority::session_actor(database, &cookie_token(headers, auth)?).await?;
    let object = input.as_object_mut().ok_or_else(auth::invalid_body)?;
    let workspace = object
        .remove("workspaceId")
        .and_then(|v| v.as_str().map(str::to_owned))
        .filter(|s| !s.is_empty())
        .ok_or_else(auth::invalid_body)?;
    let session = object
        .remove("sessionId")
        .and_then(|v| v.as_str().map(str::to_owned))
        .filter(|s| !s.is_empty())
        .ok_or_else(auth::invalid_body)?;
    if workspace != actor.workspace_id
        || !matches!(&actor.authentication,Authentication::Session{session_id} if *session_id==session)
    {
        return Err(StoreError::Forbidden.into());
    }
    Ok((database, actor, input))
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReadOptions {
    #[serde(default)]
    metadata_only: bool,
}
pub(crate) async fn read(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(options): Query<ReadOptions>,
) -> Result<Json<Value>, IssueHttpError> {
    let (database, auth) = configuration(&state)?;
    let actor = authority::session_actor(database, &cookie_token(&headers, auth)?).await?;
    Ok(Json(
        issues::read(database, &actor, options.metadata_only).await?,
    ))
}
pub(crate) async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let (database, actor, input) = context(&state, &headers, payload).await?;
    let input = CreateIssue::parse(input).map_err(|_| auth::invalid_body())?;
    Ok(Json(
        issues::create(database, &actor, &input, IssueOptions::from_env()).await?,
    ))
}
pub(crate) async fn edit(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let (database, actor, input) = context(&state, &headers, payload).await?;
    let input = EditIssues::parse(input).map_err(|_| auth::invalid_body())?;
    Ok(Json(
        issues::edit(database, &actor, &input, IssueOptions::from_env()).await?,
    ))
}
pub(crate) async fn comment(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let (database, actor, input) = context(&state, &headers, payload).await?;
    let input = CommentCommand::parse(input).map_err(|_| auth::invalid_body())?;
    Ok(Json(issues::comment(database, &actor, &input).await?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CommandEnvelope {
    command: Value,
}
pub(crate) async fn engagement(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let (database, actor, input) = context(&state, &headers, payload).await?;
    let input: CommandEnvelope = serde_json::from_value(input).map_err(|_| auth::invalid_body())?;
    Ok(Json(
        issues::engagement(database, &actor, input.command).await?,
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct QueryEnvelope {
    query: Value,
}
pub(crate) async fn query(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let (database, actor, input) = context(&state, &headers, payload).await?;
    let input: QueryEnvelope = serde_json::from_value(input).map_err(|_| auth::invalid_body())?;
    let input = forge_core::issue_query::IssueQuery::parse(input.query)
        .map_err(|_| auth::invalid_body())?;
    Ok(Json(issues::query(database, &actor, &input).await?))
}
pub(crate) async fn lifecycle(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let (database, actor, input) = context(&state, &headers, payload).await?;
    Ok(Json(issues::lifecycle(database, &actor, input).await?))
}
pub(crate) async fn inactive(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let (database, actor, input) = context(&state, &headers, payload).await?;
    Ok(Json(issues::inactive(database, &actor, input).await?))
}
pub(crate) async fn save_team_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let (database, actor, input) = context(&state, &headers, payload).await?;
    Ok(Json(
        issues::save_team_settings(database, &actor, input).await?,
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CycleQuery {
    team_id: String,
    number: Option<i64>,
}
pub(crate) async fn cycles(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let (database, actor, input) = context(&state, &headers, payload).await?;
    let input: CycleQuery = serde_json::from_value(input).map_err(|_| auth::invalid_body())?;
    if !forge_core::text::is_uuid(&input.team_id) {
        return Err(auth::invalid_body().into());
    }
    Ok(Json(
        issues::read_cycles(
            database,
            &actor,
            input.team_id.parse().map_err(|_| auth::invalid_body())?,
            input.number,
        )
        .await?,
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TeamQuery {
    team_id: String,
}
pub(crate) async fn triage(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let (database, actor, input) = context(&state, &headers, payload).await?;
    let input: TeamQuery = serde_json::from_value(input).map_err(|_| auth::invalid_body())?;
    if !forge_core::text::is_uuid(&input.team_id) {
        return Err(auth::invalid_body().into());
    }
    Ok(Json(
        issues::read_triage(
            database,
            &actor,
            input.team_id.parse().map_err(|_| auth::invalid_body())?,
        )
        .await?,
    ))
}
pub(crate) async fn history(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let (database, actor, input) = context(&state, &headers, payload).await?;
    let input: QueryEnvelope = serde_json::from_value(input).map_err(|_| auth::invalid_body())?;
    Ok(Json(issues::history(database, &actor, input.query).await?))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MentionQuery {
    issue_id: String,
    #[serde(default)]
    query: String,
}
pub(crate) async fn mentions(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let (database, actor, input) = context(&state, &headers, payload).await?;
    let input: MentionQuery = serde_json::from_value(input).map_err(|_| auth::invalid_body())?;
    if !forge_core::text::is_uuid(&input.issue_id) {
        return Err(auth::invalid_body().into());
    }
    let issue = input.issue_id.parse().map_err(|_| auth::invalid_body())?;
    Ok(Json(
        issues::mentions(database, &actor, issue, &input.query).await?,
    ))
}
pub(crate) async fn relationship(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let (database, actor, input) = context(&state, &headers, payload).await?;
    Ok(Json(issues::relationship(database, &actor, input).await?))
}
pub(crate) async fn relationships(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let (database, actor, input) = context(&state, &headers, payload).await?;
    Ok(Json(issues::relationships(database, &actor, input).await?))
}
pub(crate) async fn search_relationships(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let (database, actor, input) = context(&state, &headers, payload).await?;
    Ok(Json(
        issues::search_relationships(database, &actor, input).await?,
    ))
}
