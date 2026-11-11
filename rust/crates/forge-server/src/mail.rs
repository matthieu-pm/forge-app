use async_trait::async_trait;
use forge_core::invitations::{DeliveryError, Effect};
use forge_store::accounts::User;
use serde_json::json;
use std::time::Duration;
use url::Url;

#[derive(Debug)]
pub struct MailError;

#[async_trait]
pub trait VerificationMailer: Send + Sync {
    async fn send(&self, user: &User, url: &str) -> Result<(), MailError>;
    async fn send_invitation(&self, _invitation: &InvitationMessage) -> Result<(), MailError> {
        Err(MailError)
    }
    fn invitation_fingerprint(
        &self,
        _invitation: &InvitationMessage,
        _effect: Effect,
    ) -> Result<String, DeliveryError> {
        Err(DeliveryError::invalid())
    }
    /// Implementations must honor the effect's stable provider idempotency key.
    /// The durable caller owns its persisted replay deadline and live authority.
    async fn send_invitation_effect(
        &self,
        _invitation: &InvitationMessage,
        _effect: Effect,
    ) -> Result<String, DeliveryError> {
        Err(DeliveryError::invalid())
    }
}

#[derive(Debug, Clone)]
pub struct InvitationMessage {
    pub id: String,
    pub email: String,
    pub role: String,
    pub organization_name: String,
    pub inviter_name: String,
    pub inviter_email: String,
    pub url: String,
}

pub struct ResendMailer {
    client: reqwest::Client,
    token: String,
    from: String,
    staging: bool,
    sandbox: bool,
    endpoint: Url,
}

impl ResendMailer {
    pub fn from_environment() -> Result<Option<Self>, MailError> {
        let Some(token) = std::env::var("RESEND_API_KEY")
            .ok()
            .filter(|value| !value.trim().is_empty())
        else {
            return Ok(None);
        };
        let from = match std::env::var("RESEND_FROM_EMAIL")
            .ok()
            .filter(|value| !value.trim().is_empty())
        {
            Some(from) => from,
            None if std::env::var("NODE_ENV").as_deref() != Ok("production") => {
                "Forge <onboarding@resend.dev>".into()
            }
            None => return Err(MailError),
        };
        Self::new(
            token,
            from,
            std::env::var("FORGE_ENVIRONMENT").as_deref() == Ok("staging"),
            std::env::var("FORGE_EXTERNAL_INTEGRATIONS").as_deref() == Ok("sandbox"),
            Url::parse("https://api.resend.com/emails").map_err(|_| MailError)?,
        )
        .map(Some)
    }

    /// Explicit endpoint injection supports local provider qualification. The
    /// environment constructor always selects Resend's fixed HTTPS endpoint.
    pub fn new(
        token: String,
        from: String,
        staging: bool,
        sandbox: bool,
        endpoint: Url,
    ) -> Result<Self, MailError> {
        if token.trim().is_empty()
            || from.trim().is_empty()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
            || endpoint.host_str().is_none()
            || !(endpoint.scheme() == "https"
                || (endpoint.scheme() == "http"
                    && endpoint
                        .host_str()
                        .is_some_and(|host| host == "127.0.0.1" || host == "[::1]")))
        {
            return Err(MailError);
        }
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| MailError)?;
        Ok(Self {
            client,
            token: token.trim().into(),
            from: from.trim().into(),
            staging,
            sandbox,
            endpoint,
        })
    }
}

fn escape_html(value: &str) -> String {
    let mut result = String::new();
    for character in value.chars() {
        match character {
            '&' => result.push_str("&amp;"),
            '<' => result.push_str("&lt;"),
            '>' => result.push_str("&gt;"),
            '"' => result.push_str("&quot;"),
            '\'' => result.push_str("&#x27;"),
            _ => result.push(character),
        }
    }
    result
}

pub fn verification_html(name: &str, url: &str) -> String {
    let template = include_str!("../templates/verify-email.html");
    fill_html(
        template,
        &[
            ("FORGE_NAME_MARKER", escape_html(name)),
            ("FORGE_VERIFICATION_URL_MARKER", escape_html(url)),
        ],
    )
}
fn fill_html(template: &str, values: &[(&str, String)]) -> String {
    let mut remainder = template;
    let mut result = String::new();
    loop {
        let next = values
            .iter()
            .filter_map(|(marker, value)| {
                remainder.find(marker).map(|index| (index, marker, value))
            })
            .min_by_key(|(index, _, _)| *index);
        let Some((index, marker, value)) = next else {
            result.push_str(remainder);
            break;
        };
        result.push_str(&remainder[..index]);
        result.push_str(value);
        remainder = &remainder[index + marker.len()..];
    }
    result
}

pub fn invitation_payload(
    from: &str,
    invitation: &InvitationMessage,
    effect: Effect,
) -> Result<serde_json::Value, MailError> {
    let template = match invitation.role.as_str() {
        "owner" => include_str!("../templates/invitation-owner.html"),
        "admin" => include_str!("../templates/invitation-admin.html"),
        "member" => include_str!("../templates/invitation-member.html"),
        _ => return Err(MailError),
    };
    let preview: Vec<u16> = format!(
        "{} invited you to {} on Forge",
        invitation.inviter_name, invitation.organization_name
    )
    .encode_utf16()
    .take(150)
    .collect();
    let mut preview_html = escape_html(&String::from_utf16_lossy(&preview));
    if preview.len() < 150 {
        preview_html.push_str(&format!(
            "<div>{}</div>",
            "\u{a0}\u{200c}\u{200b}\u{200d}\u{200e}\u{200f}\u{feff}".repeat(150 - preview.len())
        ));
    }
    let html = fill_html(
        template,
        &[
            ("FORGE_INVITATION_PREVIEW_MARKER", preview_html),
            (
                "FORGE_INVITER_NAME_MARKER",
                escape_html(&invitation.inviter_name),
            ),
            (
                "FORGE_INVITER_EMAIL_MARKER",
                escape_html(&invitation.inviter_email),
            ),
            (
                "FORGE_WORKSPACE_NAME_MARKER",
                escape_html(&invitation.organization_name),
            ),
            ("FORGE_INVITATION_URL_MARKER", escape_html(&invitation.url)),
        ],
    );
    let reminder = effect == Effect::Reminder;
    let subject = if reminder {
        format!(
            "Reminder: your invitation to {} on Forge",
            invitation.organization_name
        )
    } else {
        format!(
            "{} invited you to {} on Forge",
            invitation.inviter_name, invitation.organization_name
        )
    };
    let prefix = if reminder {
        "This is a reminder that "
    } else {
        ""
    };
    Ok(
        json!({"from":from,"to":invitation.email,"subject":subject,"html":html,"text":format!("{prefix}{} ({}) invited you to join {} as {}.\n\nReview the invitation: {}\n\nSign in with this email address. The invitation expires in 48 hours.",invitation.inviter_name,invitation.inviter_email,invitation.organization_name,invitation.role,invitation.url),"tags":[{"name":"category","value":"workspace-invitation"}]}),
    )
}

#[async_trait]
impl VerificationMailer for ResendMailer {
    fn invitation_fingerprint(
        &self,
        invitation: &InvitationMessage,
        effect: Effect,
    ) -> Result<String, DeliveryError> {
        let payload = invitation_payload(&self.from, invitation, effect)
            .map_err(|_| DeliveryError::invalid())?;
        Ok(forge_core::canonical::command_input_hash(&payload))
    }
    async fn send_invitation(&self, invitation: &InvitationMessage) -> Result<(), MailError> {
        let payload = invitation_payload(&self.from, invitation, Effect::Initial)?;
        self.deliver(&invitation.email, payload).await
    }
    async fn send_invitation_effect(
        &self,
        invitation: &InvitationMessage,
        effect: Effect,
    ) -> Result<String, DeliveryError> {
        let payload = invitation_payload(&self.from, invitation, effect)
            .map_err(|_| DeliveryError::invalid())?;
        self.deliver_recorded(
            &invitation.email,
            payload,
            Some(&effect.key(&invitation.id)),
        )
        .await
    }
    async fn send(&self, user: &User, url: &str) -> Result<(), MailError> {
        let name = if user.name.is_empty() {
            "there"
        } else {
            &user.name
        };
        let payload = json!({"from": self.from, "to": user.email, "subject": "Verify your Forge email address",
            "text": format!("Hi {name},\n\nConfirm this email address for your Forge account.\nVerify your email: {url}\n\nThis link expires in one hour."),
            "html": verification_html(name, url), "tags": [{"name":"category","value":"email-verification"}]});
        self.deliver(&user.email, payload).await
    }
}
impl ResendMailer {
    async fn deliver(&self, email: &str, payload: serde_json::Value) -> Result<(), MailError> {
        self.deliver_recorded(email, payload, None)
            .await
            .map(|_| ())
            .map_err(|_| MailError)
    }
    async fn deliver_recorded(
        &self,
        email: &str,
        payload: serde_json::Value,
        key: Option<&str>,
    ) -> Result<String, DeliveryError> {
        if self.staging
            && (!self.sandbox
                || self.from != "Forge staging <staging@nexstudio.io>"
                || ![
                    "delivered@resend.dev",
                    "bounced@resend.dev",
                    "complained@resend.dev",
                ]
                .contains(&email))
        {
            return Err(DeliveryError::invalid());
        }
        let mut request = self
            .client
            .post(self.endpoint.clone())
            .bearer_auth(&self.token)
            .json(&payload);
        if let Some(key) = key {
            if key.is_empty() || key.len() > 256 || !key.bytes().all(|b| (0x20..=0x7e).contains(&b))
            {
                return Err(DeliveryError::invalid());
            }
            request = request.header("Idempotency-Key", key);
        }
        let mut response = request
            .send()
            .await
            .map_err(|_| DeliveryError::provider(None, "application_error"))?;
        let status = response.status();
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| DeliveryError::provider(None, "application_error"))?
        {
            if bytes.len() + chunk.len() > 64 * 1024 {
                return Err(DeliveryError::provider(
                    Some(status.as_u16()),
                    "application_error",
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        let body: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|_| DeliveryError::provider(Some(status.as_u16()), "application_error"))?;
        if !status.is_success() {
            // The SDK forwards provider error statusCode/name, falling back to
            // an application error when its response cannot be decoded.
            let code = body
                .get("statusCode")
                .and_then(serde_json::Value::as_u64)
                .and_then(|code| u16::try_from(code).ok());
            return Err(DeliveryError::provider(
                code,
                body["name"].as_str().unwrap_or("application_error"),
            ));
        }
        body["id"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 1024 && !id.chars().any(char::is_control))
            .map(str::to_owned)
            .ok_or_else(|| DeliveryError::provider(None, "application_error"))
    }
}
