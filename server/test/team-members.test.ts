import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { TeamError, addMember, initTeamMembers, listMembers, removeMember, workspaceOf } from '../src/team-members.js';

function setup() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, created_at INTEGER);
    CREATE TABLE bots (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT, is_primary INTEGER DEFAULT 0, created_at INTEGER);
    CREATE TABLE screens (bot_id TEXT PRIMARY KEY, user_id TEXT NOT NULL);
    CREATE TABLE computers (user_id TEXT PRIMARY KEY);
    CREATE TABLE composio_sessions (user_id TEXT PRIMARY KEY);
    INSERT INTO users VALUES ('usr_owner','owner@x.com','Gus Owner',1), ('usr_mate','Mate@x.com','Pat Mate',2), ('usr_other','other@x.com','Other',3);
    INSERT INTO bots VALUES ('bot_a','usr_owner','Thoth',1,1), ('bot_b','usr_owner','Sam',0,2), ('bot_doug','usr_mate','Doug',1,5);
    INSERT INTO screens VALUES ('bot_doug','usr_mate');
    INSERT INTO computers VALUES ('usr_owner'), ('usr_mate');
    INSERT INTO composio_sessions VALUES ('usr_mate');
  `);
  initTeamMembers(db);
  return db;
}

test('adding a member moves their bots in, keeps one main bot, and drops their own computer', () => {
  const db = setup();
  const r = addMember(db, 'usr_owner', ' mate@X.com ', 100);
  assert.equal(r.botsMoved, 1);
  assert.equal(r.member.id, 'usr_mate');
  assert.equal(workspaceOf(db, 'usr_mate'), 'usr_owner');
  assert.equal(workspaceOf(db, 'usr_owner'), 'usr_owner');
  const doug = db.prepare("SELECT user_id, is_primary FROM bots WHERE id='bot_doug'").get() as any;
  assert.deepEqual([doug.user_id, doug.is_primary], ['usr_owner', 0]);
  assert.equal((db.prepare("SELECT is_primary FROM bots WHERE id='bot_a'").get() as any).is_primary, 1);
  assert.equal((db.prepare("SELECT user_id FROM screens WHERE bot_id='bot_doug'").get() as any).user_id, 'usr_owner');
  assert.equal((db.prepare("SELECT COUNT(*) n FROM computers WHERE user_id='usr_mate'").get() as any).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM composio_sessions").get() as any).n, 0);
  assert.deepEqual(listMembers(db, 'usr_owner').map((m) => m.email), ['Mate@x.com']);
});

test('refuses unknown people, yourself, people already in a workspace, and members adding others', () => {
  const db = setup();
  assert.throws(() => addMember(db, 'usr_owner', 'nobody@x.com'), TeamError);
  assert.throws(() => addMember(db, 'usr_owner', 'owner@x.com'), /That is you/);
  addMember(db, 'usr_owner', 'mate@x.com');
  assert.throws(() => addMember(db, 'usr_other', 'mate@x.com'), /already part of a workspace/);
  assert.throws(() => addMember(db, 'usr_mate', 'other@x.com'), /Only the workspace owner/);
  assert.throws(() => addMember(db, 'usr_other', 'owner@x.com'), /members of their own/);
});

test('removing a member ends the sharing but leaves their work in the workspace', () => {
  const db = setup();
  addMember(db, 'usr_owner', 'mate@x.com');
  assert.equal(removeMember(db, 'usr_other', 'usr_mate'), false);
  assert.equal(removeMember(db, 'usr_owner', 'usr_mate'), true);
  assert.equal(workspaceOf(db, 'usr_mate'), 'usr_mate');
  assert.equal((db.prepare("SELECT user_id FROM bots WHERE id='bot_doug'").get() as any).user_id, 'usr_owner');
});
