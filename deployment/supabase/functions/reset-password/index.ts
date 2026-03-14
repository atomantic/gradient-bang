/**
 * Public Edge Function: reset-password
 *
 * Updates a user's password using the access token from a recovery link.
 * Expects Bearer token in Authorization header and new password in body.
 * No EDGE_API_TOKEN required - this is a public endpoint.
 */

import { createPublicClient } from "../_shared/auth.ts";
import { createServiceRoleClient } from "../_shared/client.ts";
import {
  enforcePublicRateLimit,
  RateLimitError,
} from "../_shared/rate_limiting.ts";
import {
  parseJsonRequest,
  requireString,
  respondWithError,
} from "../_shared/request.ts";
import { traced } from "../_shared/weave.ts";

// CORS headers for public access from web clients
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function corsResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

Deno.serve(traced("reset-password", async (req, trace) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const serviceClient = createServiceRoleClient();

  // Apply IP-based rate limiting
  const sRateLimit = trace.span("rate_limit");
  try {
    await enforcePublicRateLimit(serviceClient, req, "reset-password");
    sRateLimit.end();
  } catch (err) {
    sRateLimit.end({ error: err instanceof Error ? err.message : String(err) });
    if (err instanceof RateLimitError) {
      console.warn("reset-password.rate_limit", err.message);
      return corsResponse(
        {
          success: false,
          error: "Too many attempts. Please try again later.",
        },
        429,
      );
    }
    console.error("reset-password.rate_limit", err);
    return corsResponse(
      { success: false, error: "Rate limit check failed" },
      500,
    );
  }

  let payload;
  const sParse = trace.span("parse_request");
  try {
    payload = await parseJsonRequest(req);
    sParse.end();
  } catch (err) {
    sParse.end({ error: err instanceof Error ? err.message : String(err) });
    const response = respondWithError(err);
    if (response) {
      return corsResponse(await response.json(), response.status);
    }
    console.error("reset-password.parse", err);
    return corsResponse({ success: false, error: "Invalid JSON payload" }, 400);
  }

  try {
    // Validate Authorization header
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return corsResponse(
        { success: false, error: "Missing or invalid Authorization header" },
        401,
      );
    }
    const accessToken = authHeader.replace("Bearer ", "");

    const password = requireString(payload, "password");

    trace.setInput({ hasAccessToken: Boolean(accessToken) });

    // Password validation
    if (password.length < 6) {
      return corsResponse(
        { success: false, error: "Password must be at least 6 characters" },
        400,
      );
    }

    // Create public Supabase client and set session from recovery token
    const supabase = createPublicClient();

    const sSetSession = trace.span("set_session");
    const { data: sessionData, error: sessionError } =
      await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: "",
      });

    if (sessionError) {
      sSetSession.end({ error: sessionError.message });
      console.error("reset-password.set_session", sessionError);
      return corsResponse(
        { success: false, error: "Invalid or expired recovery token" },
        401,
      );
    }

    if (!sessionData.user) {
      sSetSession.end({ error: "No user in session" });
      return corsResponse(
        { success: false, error: "Failed to verify session" },
        401,
      );
    }
    sSetSession.end({ user_id: sessionData.user.id });

    // Update the password
    const sUpdatePassword = trace.span("update_password");
    const { error: updateError } = await supabase.auth.updateUser({
      password,
    });

    if (updateError) {
      sUpdatePassword.end({ error: updateError.message });
      console.error("reset-password.update_password", updateError);
      return corsResponse(
        { success: false, error: "Failed to update password: " + updateError.message },
        400,
      );
    }
    sUpdatePassword.end();

    trace.setOutput({ user_id: sessionData.user.id });

    return corsResponse({
      success: true,
      message: "Password has been updated successfully.",
    });
  } catch (err) {
    console.error("reset-password.unhandled", err);
    return corsResponse(
      {
        success: false,
        error: err instanceof Error ? err.message : "Internal server error",
      },
      500,
    );
  }
}));
