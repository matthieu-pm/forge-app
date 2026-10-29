# Forge domains

User-selected domain layout, 29 October 2026:

| Purpose | Origin | Current state |
| --- | --- | --- |
| Application | `https://app.forgenow.tech` | Attached to Vercel web project `prj_S0XLtdngbexhl2ao7WviBrlMScar`; verified and DNS configured |
| Future public website | `https://forgenow.tech` | Reserved for a separate future website; not attached to the app project |
| Staging web | `https://forge-staging-matthieu-pm.vercel.app` | Separate protected staging project |
| Staging runtime | `https://forge-staging-runtime-matthieu-pm.vercel.app` | Separate protected staging project |

`forgenow.tech` is registered in the existing `matthieu-pm` Vercel team. Vercel
reports authoritative nameservers `ns1.vercel-dns.com` and `ns2.vercel-dns.com`,
valid routing for `app.forgenow.tech`, and no DNS conflicts. HTTPS responds and
redirects the app root to `/inbox`. No apex redirect to the application was added.

This domain assignment serves the existing production deployment. It does not
promote the FOR-27 staging source or migrate production authentication. At the
production release, set the canonical Better Auth origin, runtime callback origin,
production OAuth clients/redirects, mail links, and billing return/webhook URLs to
the application subdomain as appropriate. Keep staging credentials, callbacks and
resources separate. Verify sign-in, callbacks and session cookies at that release;
HTTPS routing alone is not authentication cutover acceptance.
