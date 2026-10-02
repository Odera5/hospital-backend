/**
 * Cloudflare Turnstile verification utility
 * Validates the turnstileToken sent by the frontend against Cloudflare's siteverify endpoint.
 */

const CLOUDFLARE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function verifyTurnstileToken({ token, ipAddress }) {
  const secretKey = process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY?.trim();

  // If secret key is not set in the environment, bypass check with a warning (useful for local dev)
  if (!secretKey) {
    if (process.env.NODE_ENV === "production") {
      console.warn("⚠️ CLOUDFLARE_TURNSTILE_SECRET_KEY is not configured in production environment!");
    }
    return { success: true, bypassed: true };
  }

  if (!token || typeof token !== "string" || !token.trim()) {
    return {
      success: false,
      error: "Bot protection verification token is missing. Please complete the security check.",
    };
  }

  try {
    const formData = new URLSearchParams();
    formData.append("secret", secretKey);
    formData.append("response", token.trim());
    if (ipAddress) {
      // If multiple IPs are present in x-forwarded-for, take the first one
      const clientIp = String(ipAddress).split(",")[0].trim();
      if (clientIp) {
        formData.append("remoteip", clientIp);
      }
    }

    const response = await fetch(CLOUDFLARE_SITEVERIFY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formData.toString(),
    });

    if (!response.ok) {
      console.error(`Turnstile HTTP error: ${response.status} ${response.statusText}`);
      return {
        success: false,
        error: "Unable to verify security challenge at this time. Please try again.",
      };
    }

    const data = await response.json();

    if (!data.success) {
      console.warn("⚠️ Turnstile verification rejected by Cloudflare:", data["error-codes"]);
      return {
        success: false,
        errorCodes: data["error-codes"] || [],
        error: "Security verification failed. Please refresh the page and try again.",
      };
    }

    console.log(
      `🛡️ Turnstile verified successfully: host=${data.hostname || "unknown"}, ts=${data.challenge_ts}`
    );

    return {
      success: true,
      challengeTs: data.challenge_ts,
      hostname: data.hostname,
    };
  } catch (error) {
    console.error("Turnstile verification error:", error);
    // In the event of network outage between backend and Cloudflare, log and return error
    return {
      success: false,
      error: "Security verification service is temporarily unreachable. Please try again.",
    };
  }
}
