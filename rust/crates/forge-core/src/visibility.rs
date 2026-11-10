//! Resource visibility policy. Callers must also validate live membership,
//! lifecycle, credential scopes and any loop scope in the same transaction.

use crate::actor::Actor;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TeamVisibilityKind {
    Workspace,
    Private,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamVisibility {
    pub workspace_id: String,
    pub visibility: TeamVisibilityKind,
    pub member_user_ids: Vec<String>,
}

impl TeamVisibility {
    pub fn visible_to(&self, actor: &Actor) -> bool {
        self.workspace_id == actor.workspace_id
            && (self.visibility == TeamVisibilityKind::Workspace
                || actor.has_role(&["owner", "admin"])
                || self.member_user_ids.contains(&actor.user_id))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectVisibility {
    pub workspace_id: String,
    pub teams: Vec<TeamVisibility>,
}

impl ProjectVisibility {
    pub fn visible_to(&self, actor: &Actor) -> bool {
        self.workspace_id == actor.workspace_id
            && self
                .teams
                .iter()
                .all(|team| team.workspace_id == self.workspace_id)
            && (self.teams.is_empty() || self.teams.iter().any(|team| team.visible_to(actor)))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum DocumentSource {
    Workspace,
    Team { team: TeamVisibility },
    Issue { team: TeamVisibility },
    Project { project: ProjectVisibility },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentVisibility {
    pub workspace_id: String,
    pub shared_with_workspace: bool,
    pub source: DocumentSource,
}

impl DocumentVisibility {
    pub fn visible_to(&self, actor: &Actor) -> bool {
        if self.workspace_id != actor.workspace_id {
            return false;
        }
        let valid_source = match &self.source {
            DocumentSource::Workspace => true,
            DocumentSource::Team { team } | DocumentSource::Issue { team } => {
                team.workspace_id == self.workspace_id
            }
            DocumentSource::Project { project } => {
                project.workspace_id == self.workspace_id
                    && project
                        .teams
                        .iter()
                        .all(|team| team.workspace_id == self.workspace_id)
            }
        };
        if !valid_source {
            return false;
        }
        if self.shared_with_workspace {
            return true;
        }
        match &self.source {
            DocumentSource::Workspace => true,
            DocumentSource::Team { team } | DocumentSource::Issue { team } => {
                team.visible_to(actor)
            }
            DocumentSource::Project { project } => project.visible_to(actor),
        }
    }

    pub fn can_share_with_workspace(&self, actor: &Actor) -> bool {
        actor.has_role(&["owner", "admin"]) && self.visible_to(actor)
    }
}
