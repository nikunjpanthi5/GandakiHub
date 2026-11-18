export interface OtpDeliveryResult {
  deliveredVia: 'resend' | 'dev_console';
  devCode?: string;
}

function buildRegistrationEmailHtml(code: string): string {
  return `
  <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; color: #0f172a; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px;">
    <h2 style="margin: 0 0 8px; font-size: 20px; color: #0f172a;">Verify your GandakiHub account</h2>
    <p style="margin: 0 0 16px; font-size: 14px; line-height: 1.5; color: #475569;">
      Use the 6-digit verification code below to confirm ownership of your email address and activate your GandakiHub account.
    </p>
    <div style="margin: 20px 0; padding: 16px; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; text-align: center;">
      <span style="font-family: monospace; font-size: 28px; font-weight: 700; letter-spacing: 6px; color: #0f172a;">${code}</span>
    </div>
    <p style="margin: 0 0 8px; font-size: 12px; color: #64748b;">
      This code expires in 15 minutes and can only be used once.
    </p>
    <p style="margin: 0; font-size: 12px; color: #94a3b8;">
      If you did not request this verification, you can safely ignore this message. GandakiHub is an independent student-developed community platform.
    </p>
  </div>`;
}

function buildPasswordResetEmailHtml(code: string): string {
  return `
  <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; color: #0f172a; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px;">
    <h2 style="margin: 0 0 8px; font-size: 20px; color: #0f172a;">GandakiHub Password Recovery</h2>
    <p style="margin: 0 0 16px; font-size: 14px; line-height: 1.5; color: #475569;">
      A password reset was requested for your GandakiHub account. Enter the 6-digit recovery code below to set a new password.
    </p>
    <div style="margin: 20px 0; padding: 16px; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; text-align: center;">
      <span style="font-family: monospace; font-size: 28px; font-weight: 700; letter-spacing: 6px; color: #0f172a;">${code}</span>
    </div>
    <p style="margin: 0 0 8px; font-size: 12px; color: #64748b;">
      This code expires in 15 minutes. Completing a password reset revokes all active sessions for your security.
    </p>
    <p style="margin: 0; font-size: 12px; color: #94a3b8;">
      If you did not request a password reset, please ignore this email—your existing password remains unchanged.
    </p>
  </div>`;
}

export async function dispatchOtpEmail(
  email: string,
  code: string,
  purpose: 'verify_email' | 'reset_password'
): Promise<OtpDeliveryResult> {
  const isProd = process.env.NODE_ENV === 'production';
  const resendKey = process.env.RESEND_API_KEY?.trim();
  const fromAddress = process.env.EMAIL_FROM?.trim();

  if (resendKey) {
    if (!fromAddress && isProd) {
      throw new Error('EMAIL_FROM must be configured to send verification emails via Resend in production.');
    }

    const subject =
      purpose === 'reset_password'
        ? 'GandakiHub Password Recovery Code'
        : 'Verify your GandakiHub email address';
    const text =
      purpose === 'reset_password'
        ? `Your 6-digit GandakiHub password recovery code is: ${code}. It expires in 15 minutes.`
        : `Your 6-digit GandakiHub verification code is: ${code}. It expires in 15 minutes.`;
    const html =
      purpose === 'reset_password'
        ? buildPasswordResetEmailHtml(code)
        : buildRegistrationEmailHtml(code);

    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromAddress || 'GandakiHub <onboarding@resend.dev>',
        to: [email],
        subject,
        text,
        html,
      }),
    });

    if (resp.ok) {
      return { deliveredVia: 'resend' };
    }

    const errText = await resp.text().catch(() => '');
    console.error(`[GandakiHub Email] Resend API error (${resp.status}):`, errText.slice(0, 300));
    if (isProd) {
      throw new Error('Unable to deliver verification email right now. Please try again shortly.');
    }
  } else if (isProd) {
    throw new Error('RESEND_API_KEY is not configured in production for email OTP delivery.');
  }

  // Non-production / test fallback ONLY: never expose OTP codes in production logs or API responses
  if (process.env.NODE_ENV !== 'test') {
    console.info(`[GandakiHub DEV OTP] ${purpose} for ${email}: ${code}`);
  }
  return {
    deliveredVia: 'dev_console',
    devCode: code,
  };
}
