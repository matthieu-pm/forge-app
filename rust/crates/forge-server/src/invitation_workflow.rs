use crate::mail::{InvitationMessage, VerificationMailer};
use forge_core::invitations::{DeliveryError, Effect};
use forge_store::jobs::invitations::{Invitation, Transport};
use std::sync::Arc;
use url::Url;

pub struct MailTransport {
    mailer: Arc<dyn VerificationMailer>,
    base_url: Url,
}
impl MailTransport {
    pub fn new(mailer: Arc<dyn VerificationMailer>, base_url: &str) -> Result<Self, &'static str> {
        let url = Url::parse(base_url).map_err(|_| "INVALID_CONFIGURATION")?;
        if !["http", "https"].contains(&url.scheme())
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("INVALID_CONFIGURATION");
        }
        Ok(Self {
            mailer,
            base_url: url,
        })
    }
    fn message(&self, invitation: &Invitation) -> Result<InvitationMessage, DeliveryError> {
        let mut url = self
            .base_url
            .join("/accept-invitation")
            .map_err(|_| DeliveryError::invalid())?;
        url.query_pairs_mut().append_pair("id", &invitation.id);
        Ok(InvitationMessage {
            id: invitation.id.clone(),
            email: invitation.email.clone(),
            role: invitation.role.clone(),
            organization_name: invitation.organization_name.clone(),
            inviter_name: invitation.inviter_name.clone(),
            inviter_email: invitation.inviter_email.clone(),
            url: url.into(),
        })
    }
}
#[async_trait::async_trait]
impl Transport for MailTransport {
    fn fingerprint(
        &self,
        invitation: &Invitation,
        effect: Effect,
    ) -> Result<String, DeliveryError> {
        self.mailer
            .invitation_fingerprint(&self.message(invitation)?, effect)
    }
    async fn deliver(
        &self,
        invitation: &Invitation,
        effect: Effect,
    ) -> Result<String, DeliveryError> {
        self.mailer
            .send_invitation_effect(&self.message(invitation)?, effect)
            .await
    }
}
