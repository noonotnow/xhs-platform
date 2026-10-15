import { beforeEach, describe, expect, it, vi } from 'vitest';
const { client } = vi.hoisted(() => ({
  client: {query:vi.fn(),release:vi.fn()},
}));
vi.mock('@/lib/db', () => ({getPool:()=>({connect:async()=>client}),sql:vi.fn()}));
import { recoverStoredNativeSchedule } from './local-publish-job-store';

const now = new Date().toISOString();
const slot = new Date(Date.now()+86_400_000).toISOString();
const id = '00000000-0000-4000-8000-000000000001';
const noteId = '0123456789abcdef01234567';
const snapshot = {
  notionPageId:id,title:'Title',headline:'Title',caption:'Body',tags:['test'],platform:'RedNote',
  mediaType:'image',mediaUrl:'https://example.com/a.png',expectedAccountId:'owned',
  publishAt:slot,notionLastEditedTime:now,
};
const receipt = {noteId,scheduledFor:slot,acknowledgedAt:now,
  authenticatedAccount:{accountId:'owned',ownership:'owned',capturedAt:now}};
const base = {
  id,workspace_id:'isolated',notion_page_id:id,snapshot,status:'verification_pending',
  claim_token:'claim',claim_expires_at:new Date(Date.now()+120_000),lease_live:true,
  receipt_outcome:'ambiguous',note_id:null,share_url:null,created_at:now,updated_at:now,
  attempt_id:id,terminal_outcome:'outcome_unknown',active:false,payload_revision:now,
  superseded_by_attempt_id:null,attempt_authorized_at:new Date(),
  frozen_payload:{browserPayload:snapshot,timingMode:'scheduled',targetPublishAt:slot},
};
let row: Omit<typeof base, 'note_id'> & {note_id:string|null} = {...base};
let stored: {rednote_note_id:string}[] = [];
let failInsert = false;
beforeEach(()=>{
  row={...base};stored=[];failInsert=false;client.query.mockReset();client.release.mockReset();
  client.query.mockImplementation(async (sql:string)=>{
    if(sql.includes('SELECT job.*'))return{rows:[row]};
    if(sql.startsWith('SELECT rednote_note_id'))return{rows:stored};
    if(sql.includes('INSERT INTO rednote_publish_attempt_receipts')&&failInsert)throw Error('injected write failure');
    if(sql.includes("UPDATE local_publish_jobs SET status='scheduled'")){
      return{rows:[{...row,status:'scheduled',note_id:noteId,receipt_outcome:'scheduled'}]};
    }
    return{rows:[]};
  });
});
describe('atomic original-operation receipt recovery',()=>{
  it('records acceptance and identity together, without changing terminal history, source, URL or public verification',async()=>{
    const result=await recoverStoredNativeSchedule(id,'claim',receipt,'isolated');
    expect(result.status).toBe('scheduled');expect(result.noteId).toBe(noteId);
    const sql=client.query.mock.calls.map(call=>call[0] as string);
    expect(sql[0]).toBe('BEGIN');expect(sql.at(-1)).toBe('COMMIT');
    expect(sql.findIndex(s=>s.includes("receipt_lookup_state='found'")))
      .toBeLessThan(sql.findIndex(s=>s.includes('INSERT INTO rednote_publish_attempt_receipts')));
    expect(sql.join('\n')).not.toMatch(/SET terminal_outcome|SET snapshot|SET share_url|SET verified_at/);
    expect(client.release).toHaveBeenCalledOnce();
  });
  it('rolls back the identity as well if the receipt write fails',async()=>{
    failInsert=true;
    await expect(recoverStoredNativeSchedule(id,'claim',receipt,'isolated')).rejects.toThrow('injected');
    expect(client.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(client.query.mock.calls.some(c=>c[0]==='COMMIT')).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  });
  it('does not append a second receipt or audit event after a lost response',async()=>{
    row={...base,status:'scheduled',note_id:noteId,receipt_outcome:'scheduled'};
    stored=[{rednote_note_id:noteId}];
    const result=await recoverStoredNativeSchedule(id,'claim',receipt,'isolated');
    expect(result.noteId).toBe(noteId);
    expect(client.query.mock.calls.some(c=>(c[0] as string).includes('INSERT'))).toBe(false);
  });
  it('rejects an expired lease or mismatched account before any receipt write',async()=>{
    for(const expired of [true,false]){
      row={...base,lease_live:!expired};
      const input=expired?receipt:{...receipt,authenticatedAccount:{...receipt.authenticatedAccount,accountId:'other'}};
      await expect(recoverStoredNativeSchedule(id,'claim',input,'isolated')).rejects.toThrow();
    }
    expect(client.query.mock.calls.some(c=>(c[0] as string).includes('INSERT'))).toBe(false);
  });
});
