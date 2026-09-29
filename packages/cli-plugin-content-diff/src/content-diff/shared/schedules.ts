// Inlined into the generated migration runtime by scripts/runtime-shared.mjs.
// Keep it dependency-free; any change changes the runtime bytes.

import type { RecordScheduleSnapshot } from '../types';
import { sharedFailure } from './failure-factory';
import { isObject } from './json';

/** The schedule timestamps a record's `meta` announces. */
export interface ScheduleMarkers {
  publication: boolean;
  unpublishing: boolean;
}

/**
 * Reads a record's exact publication and unpublishing schedule scopes from
 * the private current-vs-published response. Both relationships must be
 * present, and the first included resource a relationship names must be
 * complete. When `markers` are given, every schedule they announce must
 * resolve to an included resource. Timestamps are returned as read; callers
 * canonicalize them with canonicalizeSchedules.
 */
export function parseScheduleDetails(
  raw: unknown,
  recordId: string,
  markers?: ScheduleMarkers,
): RecordScheduleSnapshot {
  if (
    !isObject(raw) ||
    !isObject(raw.data) ||
    !isObject(raw.data.relationships) ||
    !Array.isArray(raw.included)
  ) {
    throw sharedFailure(
      'scheduleContract',
      scheduleContractMessage(
        recordId,
        'The current-vs-published schedule response has an unsupported shape.',
      ),
      { recordId },
    );
  }
  const publication = scheduleIncludedResource(
    raw.data.relationships,
    raw.included,
    'scheduled_publication',
    recordId,
  );
  const unpublishing = scheduleIncludedResource(
    raw.data.relationships,
    raw.included,
    'scheduled_unpublishing',
    recordId,
  );
  if (markers?.publication && !publication) {
    throw sharedFailure(
      'scheduleContract',
      scheduleContractMessage(
        recordId,
        'Publication schedule metadata exists but its exact scope was not included.',
      ),
      { recordId },
    );
  }
  if (markers?.unpublishing && !unpublishing) {
    throw sharedFailure(
      'scheduleContract',
      scheduleContractMessage(
        recordId,
        'Unpublishing schedule metadata exists but its exact scope was not included.',
      ),
      { recordId },
    );
  }

  return {
    publication: publication
      ? {
          at: requiredScheduleTime(
            publication.attributes.publication_scheduled_at,
            'scheduled_publication',
            recordId,
          ),
          selective:
            publication.attributes.selective_publication === null
              ? null
              : parseScheduleSelectivePublication(
                  publication.attributes.selective_publication,
                  recordId,
                ),
        }
      : null,
    unpublishing: unpublishing
      ? {
          at: requiredScheduleTime(
            unpublishing.attributes.unpublishing_scheduled_at,
            'scheduled_unpublishing',
            recordId,
          ),
          locales:
            unpublishing.attributes.content_in_locales === null
              ? null
              : parseScheduleLocales(
                  unpublishing.attributes.content_in_locales,
                  recordId,
                ),
        }
      : null,
  };
}

function scheduleIncludedResource(
  relationships: Record<string, any>,
  included: unknown[],
  relationshipName: string,
  recordId: string,
): Record<string, any> | null {
  const relationship = relationships[relationshipName];
  if (
    !isObject(relationship) ||
    !Object.prototype.hasOwnProperty.call(relationship, 'data')
  ) {
    throw sharedFailure(
      'scheduleContract',
      scheduleContractMessage(
        recordId,
        `The exact ${relationshipName} relationship was not included.`,
      ),
      { recordId },
    );
  }
  const data = relationship.data;
  if (data === null) return null;
  if (
    !isObject(data) ||
    typeof data.id !== 'string' ||
    data.id.length === 0 ||
    data.type !== relationshipName
  ) {
    throw sharedFailure(
      'scheduleContract',
      scheduleContractMessage(
        recordId,
        `The ${relationshipName} relationship has an unsupported shape.`,
      ),
      { recordId },
    );
  }
  const resource = included.find(
    (candidate) =>
      isObject(candidate) &&
      candidate.id === data.id &&
      candidate.type === relationshipName,
  );
  if (!isObject(resource) || !isObject(resource.attributes)) {
    throw sharedFailure(
      'scheduleContract',
      scheduleContractMessage(
        recordId,
        `The exact ${relationshipName} resource was not included.`,
      ),
      { recordId },
    );
  }
  return resource;
}

function requiredScheduleTime(
  value: unknown,
  relationshipName: string,
  recordId: string,
): string {
  if (typeof value !== 'string') {
    throw sharedFailure(
      'scheduleContract',
      scheduleContractMessage(
        recordId,
        `The exact ${relationshipName} time was not included.`,
      ),
      { recordId },
    );
  }
  return value;
}

function parseScheduleSelectivePublication(
  value: unknown,
  recordId: string,
): { locales: string[]; nonLocalized: boolean } {
  if (!isObject(value) || typeof value.non_localized_content !== 'boolean') {
    throw sharedFailure(
      'scheduleContract',
      scheduleContractMessage(
        recordId,
        'The selective publication scope has an unsupported shape.',
      ),
      { recordId },
    );
  }
  return {
    locales: parseScheduleLocales(value.content_in_locales, recordId),
    nonLocalized: value.non_localized_content,
  };
}

function parseScheduleLocales(value: unknown, recordId: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((locale) => typeof locale !== 'string')
  ) {
    throw sharedFailure(
      'scheduleContract',
      scheduleContractMessage(
        recordId,
        'The exact schedule locale scope was not included.',
      ),
      { recordId },
    );
  }
  return [...value];
}

function scheduleContractMessage(recordId: string, reason: string): string {
  return `Cannot read complete schedule details for record ${recordId}; the private current-vs-published response contract changed. ${reason}`;
}
