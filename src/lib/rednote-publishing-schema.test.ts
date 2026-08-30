import { describe, expect, it } from 'vitest';
import {
  missingRednoteSchemaMigrations,
  parseExpectedMissing,
  RednoteSchemaPrerequisitesMissingError,
  RednoteSchemaStateChangedError,
} from './rednote-publishing-schema';

describe('RedNote publishing schema migration gate', () => {
  it('normalizes an exact expected set into migration order', () => {
    expect(parseExpectedMissing(['021', '018', '020', '018'])).toEqual([
      '018',
      '020',
      '021',
    ]);
  });

  it('rejects migration names outside the controlled set', () => {
    expect(() => parseExpectedMissing(['022'])).toThrow(
      'expectedMissing contains an unsupported migration',
    );
  });

  it('reports every migration that is not fully ready', () => {
    expect(missingRednoteSchemaMigrations({
      '018': true,
      '019': false,
      '020': false,
      '021': true,
    })).toEqual(['019', '020']);
  });

  it('retains expected and actual state for a safe 409 response', () => {
    const error = new RednoteSchemaStateChangedError(
      ['018', '019'],
      ['019'],
    );
    expect(error.expectedMissing).toEqual(['018', '019']);
    expect(error.actualMissing).toEqual(['019']);
  });

  it('retains missing prerequisite names for a safe 409 response', () => {
    const error = new RednoteSchemaPrerequisitesMissingError([
      'local_publish_jobs',
      'xhs_publish_receipts',
    ]);
    expect(error.missingPrerequisites).toEqual([
      'local_publish_jobs',
      'xhs_publish_receipts',
    ]);
  });
});