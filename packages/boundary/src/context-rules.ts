// Two small rules the boundary's context factory (`bin.ts`) applies to every invocation,
// kept here so the production factory and the tests that exercise it read ONE definition.
// Both were the root of boundary bugs (2026-09-17/001 and 2026-11-21/002): a tool whose
// venue account is not resolved gets no venue-bound context, and the account only ever
// arrives through a payload key the tool schema declares.
import { isReadOnlyCategory } from '@traderton/domain';
import type { ToolCategory } from '@traderton/domain';

/** The two registry fields the venue-resolution rule reads. */
export interface VenueResolutionToolInfo {
  category: ToolCategory;
  ownerScopedNoVenue?: boolean;
}

/**
 * True when a tool drives no executor and so needs no venue coordinates: it is read-only
 * (its drive target is never invoked) OR it declares `ownerScopedNoVenue` (an owner-scoped
 * write that touches tables or agent state directly). The resolver then takes the venue
 * account only from the payload's `venueAccountId`, if present.
 *
 * An unregistered tool is treated as the default read-only category, exactly as the
 * factory always did.
 */
export function skipsVenueResolution(tool: VenueResolutionToolInfo | undefined): boolean {
  const category: ToolCategory = tool?.category ?? 'read-config';
  return isReadOnlyCategory(category) || tool?.ownerScopedNoVenue === true;
}

/**
 * True when the venue-bound `presetAssessment` context may be built: the subject is an
 * agent and the request resolved a non-empty venue account. Anything else leaves it
 * undefined, and the preset tools then refuse with "preset assessment not available".
 */
export function canBuildPresetAssessment(actorType: string, resolvedVenueAccountId: string): boolean {
  return actorType === 'agent' && resolvedVenueAccountId !== '';
}
