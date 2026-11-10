use async_trait::async_trait;
use forge_store::accounts::User;
use serde_json::json;
use std::time::Duration;

#[derive(Debug)]
pub struct MailError;

#[async_trait]
pub trait VerificationMailer: Send + Sync {
    async fn send(&self, user: &User, url: &str) -> Result<(), MailError>;
    async fn send_invitation(&self, _invitation: &InvitationMessage) -> Result<(), MailError> {
        Err(MailError)
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
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| MailError)?;
        Ok(Some(Self {
            client,
            token,
            from,
            staging: std::env::var("FORGE_ENVIRONMENT").as_deref() == Ok("staging"),
            sandbox: std::env::var("FORGE_EXTERNAL_INTEGRATIONS").as_deref() == Ok("sandbox"),
        }))
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

#[async_trait]
impl VerificationMailer for ResendMailer {
    async fn send_invitation(&self, invitation: &InvitationMessage) -> Result<(), MailError> {
        let template = match invitation.role.as_str() {
            "owner" => include_str!("../templates/invitation-owner.html"),
            "admin" => include_str!("../templates/invitation-admin.html"),
            "member" => include_str!("../templates/invitation-member.html"),
            _ => return Err(MailError),
        };
        let html = fill_html(
            template,
            &[
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
        self.deliver(&invitation.email,json!({"from":self.from,"to":invitation.email,"subject":format!("{} invited you to {} on Forge",invitation.inviter_name,invitation.organization_name),"html":html,"text":format!("{} ({}) invited you to join {} as {}.\n\nReview the invitation: {}\n\nSign in with this email address. The invitation expires in 48 hours.",invitation.inviter_name,invitation.inviter_email,invitation.organization_name,invitation.role,invitation.url),"tags":[{"name":"category","value":"workspace-invitation"}]})).await
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
            return Err(MailError);
        }
        let response = self
            .client
            .post("https://api.resend.com/emails")
            .bearer_auth(&self.token)
            .json(&payload)
            .send()
            .await
            .map_err(|_| MailError)?;
        if !response.status().is_success() {
            return Err(MailError);
        }
        Ok(())
    }
}
