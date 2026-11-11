use crate::text::{length, trim};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

pub const TEAM_COLORS: [&str; 8] = [
    "#94a3b8", "#818cf8", "#38bdf8", "#34d399", "#facc15", "#fb923c", "#fb7185", "#f472b6",
];
pub const RECOVERY_DAYS: i64 = 30;
#[derive(Debug, thiserror::Error)]
pub enum TeamError {
    #[error("The team input is invalid.")]
    InvalidInput,
    #[error("Use at least one letter or number in the team name.")]
    EmptySlug,
    #[error("A team with this name already exists in the workspace.")]
    SlugTaken,
    #[error("This identifier is already used by another team.")]
    IdentifierTaken,
    #[error(
        "Your workspace has reached its plan’s team limit. Archive a team or upgrade your plan to add another."
    )]
    TeamLimit,
    #[error("The team no longer exists.")]
    NotFound,
    #[error("The team name did not match, or the team no longer exists.")]
    ConfirmationMismatch,
    #[error(
        "Another active team now uses this name or identifier. Rename that team before restoring this one."
    )]
    RestoreConflict,
    #[error("You are not a member of this team.")]
    NotMember,
    #[error("Assign another team lead before leaving this team.")]
    LastLead,
}
impl TeamError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidInput | Self::EmptySlug => "INVALID_INPUT",
            Self::SlugTaken => "SLUG_TAKEN",
            Self::IdentifierTaken => "IDENTIFIER_TAKEN",
            Self::TeamLimit => "TEAM_LIMIT",
            Self::NotFound => "TEAM_NOT_FOUND",
            Self::ConfirmationMismatch => "TEAM_NOT_FOUND_OR_NAME_MISMATCH",
            Self::RestoreConflict => "RESTORE_CONFLICT",
            Self::NotMember => "NOT_A_MEMBER",
            Self::LastLead => "LAST_LEAD",
        }
    }
    pub fn field(&self) -> Option<&'static str> {
        match self {
            Self::SlugTaken | Self::EmptySlug => Some("name"),
            Self::IdentifierTaken => Some("identifier"),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IconKind {
    Icon,
    Emoji,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamIcon {
    pub kind: IconKind,
    pub value: String,
    pub color: String,
}
impl TeamIcon {
    pub(crate) fn normalize(&mut self) -> Result<(), TeamError> {
        if !TEAM_COLORS.contains(&self.color.as_str()) {
            return Err(TeamError::InvalidInput);
        }
        match self.kind {
            IconKind::Emoji => {
                self.value = trim(&self.value).into();
                if self.value.is_empty() || length(&self.value) > 32 {
                    return Err(TeamError::InvalidInput);
                }
            }
            IconKind::Icon => {
                static NAME: OnceLock<regex::Regex> = OnceLock::new();
                if !NAME
                    .get_or_init(|| regex::Regex::new(r"^[A-Za-z][A-Za-z0-9]*Icon$").unwrap())
                    .is_match(&self.value)
                {
                    return Err(TeamError::InvalidInput);
                }
            }
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EstimationScheme {
    None,
    Exponential,
    Fibonacci,
    Linear,
    Tshirt,
}

pub fn valid_timezone(value: &str) -> bool {
    if chrono_tz::TZ_VARIANTS
        .iter()
        .any(|tz| tz.name().eq_ignore_ascii_case(value))
    {
        return true;
    }
    let bytes = value.as_bytes();
    // Intl accepts fixed offsets as well as IANA names.
    if matches!(bytes.first(), Some(b'+' | b'-')) {
        let digits: Vec<_> = bytes[1..].iter().copied().filter(|b| *b != b':').collect();
        if matches!(bytes.len(), 3 | 5 | 6)
            && (bytes.len() != 6 || bytes[3] == b':')
            && matches!(digits.len(), 2 | 4)
            && digits.iter().all(u8::is_ascii_digit)
        {
            let hours = (digits[0] - b'0') * 10 + digits[1] - b'0';
            let minutes = if digits.len() == 4 {
                (digits[2] - b'0') * 10 + digits[3] - b'0'
            } else {
                0
            };
            return hours < 24 && minutes < 60;
        }
    }
    false
}
fn normalized_name(value: &str) -> Result<String, TeamError> {
    let s = trim(value);
    if s.is_empty() || length(s) > 80 {
        Err(TeamError::InvalidInput)
    } else {
        Ok(s.into())
    }
}
fn normalized_identifier(value: &str) -> Result<String, TeamError> {
    let s = trim(value).to_uppercase();
    if s.is_empty()
        || s.len() > 5
        || !s.as_bytes()[0].is_ascii_uppercase()
        || !s
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
    {
        Err(TeamError::InvalidInput)
    } else {
        Ok(s)
    }
}
pub fn slugify_team_name(value: &str) -> String {
    let decomposed: String = value
        .nfkd()
        .filter(|c| !('\u{0300}'..='\u{036f}').contains(c))
        .collect();
    let mut result = String::new();
    let mut separator = false;
    for byte in trim(&decomposed).to_lowercase().bytes() {
        if byte.is_ascii_lowercase() || byte.is_ascii_digit() {
            if separator && !result.is_empty() {
                result.push('-');
            }
            result.push(byte as char);
            separator = false;
        } else {
            separator = true;
        }
    }
    result.truncate(result.len().min(64));
    result
}
pub fn valid_slug(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('-')
        && !value.ends_with('-')
        && !value.contains("--")
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateTeam {
    pub name: String,
    pub identifier: String,
    pub icon: TeamIcon,
    pub timezone: String,
}
impl CreateTeam {
    pub fn parse(value: serde_json::Value) -> Result<Self, TeamError> {
        let mut input: Self = serde_json::from_value(value).map_err(|_| TeamError::InvalidInput)?;
        input.name = normalized_name(&input.name)?;
        input.identifier = normalized_identifier(&input.identifier)?;
        input.icon.normalize()?;
        input.timezone = trim(&input.timezone).into();
        if !valid_timezone(&input.timezone) {
            return Err(TeamError::InvalidInput);
        }
        Ok(input)
    }
}
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<TeamIcon>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identifier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimation_scheme: Option<EstimationScheme>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue_email_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detailed_history_enabled: Option<bool>,
}
impl TeamSettings {
    pub fn parse(value: serde_json::Value) -> Result<Self, TeamError> {
        let Some(object) = value.as_object() else {
            return Err(TeamError::InvalidInput);
        };
        if object.is_empty() || object.values().any(serde_json::Value::is_null) {
            return Err(TeamError::InvalidInput);
        }
        let mut settings: Self =
            serde_json::from_value(value).map_err(|_| TeamError::InvalidInput)?;
        if let Some(icon) = &mut settings.icon {
            icon.normalize()?;
        }
        if let Some(name) = &mut settings.name {
            *name = normalized_name(name)?;
        }
        if let Some(id) = &mut settings.identifier {
            *id = normalized_identifier(id)?;
        }
        if let Some(description) = &mut settings.description {
            *description = trim(description).into();
            if length(description) > 500 {
                return Err(TeamError::InvalidInput);
            }
        }
        if let Some(timezone) = &mut settings.timezone {
            *timezone = trim(timezone).into();
            if !valid_timezone(timezone) {
                return Err(TeamError::InvalidInput);
            }
        }
        Ok(settings)
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamSummary {
    pub id: Uuid,
    pub slug: String,
    pub identifier: String,
    pub name: String,
    pub icon: TeamIcon,
    pub timezone: String,
    pub description: String,
    pub visibility: String,
    pub estimation_scheme: EstimationScheme,
    pub issue_email_enabled: bool,
    pub detailed_history_enabled: bool,
    pub created_at: DateTime<Utc>,
}
