// adminPinClaim.js — who may set the FIRST PIN of a participant.
//
// /api/set-pin lets a participant with no PIN set their first one without any
// proof ("there's nothing to prove yet"). That is the intended model for a
// regular participant, but not for an admin: a quiniela is created with its
// creator as admin and `pin: null`, so if the creator left the onboarding
// before choosing a PIN, anyone who opened the link could tap the creator's
// name, choose a PIN and walk away with the admin session. The same goes for
// any admin left without a PIN (reset by another admin, or promoted before
// ever choosing one).
//
// So the first PIN of an ADMIN needs proof of being that admin, one of:
//   - the setup claim: an HttpOnly cookie create-quiniela hands only to the
//     browser that created the quiniela, bound to that exact creator id and
//     slug (see issueAdminSetupClaim in server.js);
//   - an admin/owner credential for this quiniela (the owner password the
//     creator chose at creation, or another admin's PIN/session) — the same
//     rule every other admin write already uses.
// Everything else about set-pin is unchanged.

const ADMIN_SETUP_CLAIM_PURPOSE = "admin_setup_claim";
// Long enough to finish onboarding later the same week on the same device;
// after that, the owner password is the way back in.
const ADMIN_SETUP_CLAIM_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function adminSetupClaimCookieName(slug) {
  return "qracks_setup_" + (slug || "_root");
}

function buildAdminSetupClaimPayload({ slug, participantId, now }) {
  return {
    purpose: ADMIN_SETUP_CLAIM_PURPOSE,
    slug: slug || "_root",
    participantId,
    issuedAt: now,
  };
}

// `claim` is the already signature-verified payload (or null).
function isValidAdminSetupClaim(claim, { slug, participantId, now }) {
  if (!claim || typeof claim !== "object") return false;
  if (claim.purpose !== ADMIN_SETUP_CLAIM_PURPOSE) return false;
  if (claim.slug !== (slug || "_root")) return false;
  if (!participantId || claim.participantId !== participantId) return false;
  if (!Number.isFinite(claim.issuedAt)) return false;
  const age = now - claim.issuedAt;
  return age >= 0 && age <= ADMIN_SETUP_CLAIM_MAX_AGE_MS;
}

// Only the "no PIN yet" branch is decided here; a participant who already has
// a PIN keeps going through the current-PIN check in set-pin.
function decideFirstPin({ participant, hasValidSetupClaim, isAdminOrOwner }) {
  if (!participant || participant.pin) return { ok: true };
  if (!participant.isAdmin) return { ok: true };
  if (hasValidSetupClaim || isAdminOrOwner) return { ok: true };
  return { ok: false, error: "admin_claim_required" };
}

module.exports = {
  ADMIN_SETUP_CLAIM_PURPOSE,
  ADMIN_SETUP_CLAIM_MAX_AGE_MS,
  adminSetupClaimCookieName,
  buildAdminSetupClaimPayload,
  isValidAdminSetupClaim,
  decideFirstPin,
};
