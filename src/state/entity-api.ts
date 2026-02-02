import { BaseEntity, ValidationError } from '../domain/types';

// Standard Response Wrapper
export interface EntityResponse {
  success: boolean;
  message: string;
  data?: any;
  errors?: ValidationError[];
}

// Universal Mutation Request
// The LLM (or UI) sends a partial or complete entity.
// If valid, it's merged into the state.
export interface UpsertEntityRequest<T extends BaseEntity> {
  // Discriminator to know which collection to update
  entity_type: 'IR';

  // The payload.
  // - If `id` is present and matches existing, it's an UPDATE.
  // - If `id` is missing or new, it's a CREATE.
  entity: Partial<T>; // label removed as it is not part of Note
}

export interface DeleteEntityRequest {
  entity_type: 'IR';
  entity_id: string;
  reason?: string; // For audit logs
}

export interface PatchOperation {
  op: 'add' | 'remove' | 'replace';
  path: string; // e.g. "/relations" or "/relations/-" (append)
  value?: any;
}

export interface PatchEntityRequest {
  entity_type: 'IR';
  entity_id: string;
  patches: PatchOperation[];
}

// Side Effect / Result Inspection
// When an Upsert happens, we might want to know what else changed.
// e.g. Upserting a generic "Pizza" Event might trigger a "Research Needed" side effect.
export interface MutationResult {
  entity_id: string;
  operation: 'created' | 'updated';

  // Did this trigger a research need?
  research_required?: {
    query: string;
    context: string;
  };

  // Did this auto-update other entities?
  side_effects?: {
    entity_type: string;
    entity_id: string;
    operation: string;
  }[];
}
