/** A stable identity captured in this migration's baseline or declared in its script. */
export type ContentMigrationIdentity = string | { id: string; type?: string };

/** JSON content only: field values are validated against the captured schema at runtime. */
export type ContentMigrationValue =
  | string
  | number
  | boolean
  | null
  | ContentMigrationValue[]
  | { [key: string]: ContentMigrationValue };

export type ContentMigrationRecordMetadata = {
  created_at?: string;
  first_published_at?: string | null;
  stage?: ContentMigrationIdentity | null;
};

export type ContentMigrationRecordUpdate = {
  [field: string]: ContentMigrationValue | undefined;
  id?: string;
  type?: 'item';
  item_type?: ContentMigrationIdentity;
  meta?: ContentMigrationRecordMetadata;
  parent_id?: ContentMigrationIdentity | null;
  position?: number;
};

export type ContentMigrationRecordCreate = ContentMigrationRecordUpdate & {
  /** New identities must be explicit so references remain stable during planning. */
  id: string;
  item_type: ContentMigrationIdentity;
  /** Non-draft models also require first_published_at; the captured schema checks this. */
  meta: ContentMigrationRecordMetadata & { created_at: string };
};

/** Local intended content, not a server response: no CMA version or lifecycle metadata. */
export interface ContentMigrationRecord {
  id: string;
  type: 'item';
  item_type: { id: string; type: 'item_type' };
  /** Model-specific field values need narrowing before use. */
  [field: string]: unknown;
}

export interface ContentMigrationScheduledPublication {
  publication_scheduled_at: string;
  selective_publication?: {
    content_in_locales?: string[] | null;
    non_localized_content: boolean;
  } | null;
}

export interface ContentMigrationScheduledUnpublishing {
  unpublishing_scheduled_at: string;
  content_in_locales?: string[] | null;
}

export interface ContentMigrationCollectionCreate {
  id: string;
  type?: 'upload_collection';
  label: string;
  parent?: ContentMigrationIdentity | null;
  /** The CMA appends newly created folders; use update to move them afterward. */
  position?: number;
}

export type ContentMigrationCollectionUpdate =
  Partial<ContentMigrationCollectionCreate>;

/** Local folder state; parentId is the intended identity, not a CMA relationship. */
export interface ContentMigrationCollection {
  id: string;
  label: string;
  parentId: string | null;
  position: number;
  hash: string;
}

export interface ContentMigrationUploadMetadata {
  alt?: Record<string, string | null>;
  title?: Record<string, string | null>;
  custom_data?: Record<string, Record<string, ContentMigrationValue>>;
  focal_point?: { x: number; y: number } | null;
  poster_time?: number | null;
}

export interface ContentMigrationUploadUpdate {
  id?: string;
  type?: 'upload';
  basename?: string;
  author?: string | null;
  copyright?: string | null;
  notes?: string | null;
  tags?: string[];
  default_field_metadata?: ContentMigrationUploadMetadata;
  upload_collection?: ContentMigrationIdentity | null;
}

export interface ContentMigrationUploadCreate
  extends ContentMigrationUploadUpdate {
  id: string;
  /** Must identify an existing, verified binary in this migration's companion directory. */
  localPath: string;
  filename?: string;
}

/** Only these local attributes are returned; CDN URLs and CMA metadata are unavailable. */
export interface ContentMigrationUpload {
  id: string;
  basename: string;
  author?: string | null;
  copyright?: string | null;
  notes?: string | null;
  tags?: string[];
  default_field_metadata?: ContentMigrationUploadMetadata;
}

/**
 * Supported, awaited CMA-shaped mutations recorded locally by content:apply.
 * These calls describe desired content; they do not immediately call the CMA.
 * Reads, schema changes, client configuration and arbitrary CMA methods are unavailable.
 */
export interface ContentMigrationClient {
  readonly items: Readonly<{
    create(body: ContentMigrationRecordCreate): Promise<ContentMigrationRecord>;
    update(
      item: ContentMigrationIdentity,
      body: ContentMigrationRecordUpdate,
    ): Promise<ContentMigrationRecord>;
    publish(
      item: ContentMigrationIdentity,
      selection?: undefined,
      options?: { recursive: false },
    ): Promise<ContentMigrationRecord>;
    unpublish(
      item: ContentMigrationIdentity,
      selection?: undefined,
      options?: { recursive: false },
    ): Promise<ContentMigrationRecord>;
    destroy(item: ContentMigrationIdentity): Promise<ContentMigrationRecord>;
  }>;
  readonly scheduledPublication: Readonly<{
    create(
      item: ContentMigrationIdentity,
      body: ContentMigrationScheduledPublication,
    ): Promise<ContentMigrationScheduledPublication & { id: string }>;
    destroy(item: ContentMigrationIdentity): Promise<{ id: string }>;
  }>;
  readonly scheduledUnpublishing: Readonly<{
    create(
      item: ContentMigrationIdentity,
      body: ContentMigrationScheduledUnpublishing,
    ): Promise<ContentMigrationScheduledUnpublishing & { id: string }>;
    destroy(item: ContentMigrationIdentity): Promise<{ id: string }>;
  }>;
  readonly uploadCollections: Readonly<{
    create(
      body: ContentMigrationCollectionCreate,
    ): Promise<ContentMigrationCollection>;
    update(
      collection: ContentMigrationIdentity,
      body: ContentMigrationCollectionUpdate,
    ): Promise<ContentMigrationCollection>;
    destroy(
      collection: ContentMigrationIdentity,
    ): Promise<ContentMigrationCollection>;
  }>;
  readonly uploads: Readonly<{
    createFromLocalFile(
      body: ContentMigrationUploadCreate,
    ): Promise<ContentMigrationUpload>;
    update(
      upload: ContentMigrationIdentity,
      body: ContentMigrationUploadUpdate & { path?: never },
    ): Promise<ContentMigrationUpload>;
    update(
      upload: ContentMigrationIdentity,
      body: ContentMigrationUploadUpdate & { path: string },
      options: { replace_strategy: 'create_new_url' },
    ): Promise<ContentMigrationUpload>;
    destroy(upload: ContentMigrationIdentity): Promise<{ id: string }>;
  }>;
}
