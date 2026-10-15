'use strict';

const { addActivity } = require('./contractors');

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Lead notifications: an email to the contractor (BCC the agency), and an optional
 * forward to the contractor's existing lead endpoint (e.g. their Google Apps Script),
 * so sheets that were set up before the CRM keep filling.
 * transport and fetchImpl are injectable for tests.
 */
function createNotifier({ db, config, transport, fetchImpl = fetch, log = console }) {
  let mailer = transport || null;
  const smtpReady = () => {
    if (mailer) return mailer;
    if (!config.smtp.host || !config.smtp.user) return null;
    const nodemailer = require('nodemailer');
    mailer = nodemailer.createTransport({
      host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure,
      auth: { user: config.smtp.user, pass: config.smtp.pass },
    });
    return mailer;
  };

  async function emailLead(contractor, lead) {
    const transporter = smtpReady();
    if (!transporter) return;
    const toContractor = contractor && contractor.notify_leads && contractor.email;
    const to = toContractor ? contractor.email : config.adminNotifyEmail;
    if (!to) return;
    const biz = contractor ? contractor.business_name : (lead.business_label || 'Unassigned');
    const rows = [
      ['Name', lead.name], ['Phone', lead.phone], ['Email', lead.email],
      ['Service', lead.service], ['Timeline', lead.timeline], ['Details', lead.message],
    ].filter(([, v]) => v);
    await transporter.sendMail({
      from: config.smtp.from,
      to,
      bcc: toContractor && config.adminNotifyEmail ? config.adminNotifyEmail : undefined,
      replyTo: lead.email || undefined,
      subject: `New estimate request${lead.service ? `: ${lead.service}` : ''} - ${biz}`,
      text: `New estimate request from your website.\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nCall them back fast - most homeowners hire the first contractor who responds.\n`,
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;color:#1B1815">
        <h2 style="margin:0 0 6px">New estimate request</h2>
        <p style="margin:0 0 18px;color:#575049">From the ${esc(biz)} website</p>
        <table style="border-collapse:collapse;width:100%">${rows.map(([k, v]) =>
          `<tr><td style="padding:8px;border-bottom:1px solid #E2DCD1;color:#575049;width:110px;vertical-align:top">${esc(k)}</td>
           <td style="padding:8px;border-bottom:1px solid #E2DCD1">${esc(v).replace(/\n/g, '<br>')}</td></tr>`).join('')}
        </table>
        ${lead.phone ? `<p style="margin:22px 0"><a href="tel:${esc(lead.phone.replace(/[^0-9+]/g, ''))}" style="background:#A8500F;color:#fff;padding:12px 20px;text-decoration:none;border-radius:4px;font-weight:bold">Call ${esc(lead.name || 'them')} back</a></p>` : ''}
        <p style="color:#8A8178;font-size:12px">Sent by AZ Contractor Pro</p></div>`,
    });
  }

  async function forwardLead(contractor, lead) {
    if (!contractor || !contractor.lead_forward_url) return;
    // Same body shape and content type the site's own no-cors fetch sends
    const body = JSON.stringify({
      name: lead.name, phone: lead.phone, email: lead.email, service: lead.service,
      timeline: lead.timeline, message: lead.message,
      business: contractor.business_name, submitted: lead.submitted_at || lead.created_at,
    });
    const res = await fetchImpl(contractor.lead_forward_url, {
      method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8' }, body,
      redirect: 'manual', signal: AbortSignal.timeout(8000),
    });
    if (res.status >= 400) throw new Error(`forward endpoint returned ${res.status}`);
  }

  /** Fire-and-forget: a slow mail server or sheet must never fail the website's form post. */
  function leadReceived(contractor, lead) {
    if (lead.status === 'spam') return Promise.resolve();
    const jobs = [
      emailLead(contractor, lead).catch(err => log.warn(`Lead email failed: ${err.message}`)),
      forwardLead(contractor, lead).catch(err => {
        log.warn(`Lead forward failed: ${err.message}`);
        if (contractor) addActivity(db, contractor.id, 'system', `Could not forward lead to ${contractor.lead_forward_url}: ${err.message}`);
      }),
    ];
    return Promise.all(jobs);
  }

  return { leadReceived, smtpConfigured: () => !!(transport || (config.smtp.host && config.smtp.user)) };
}

module.exports = { createNotifier };
