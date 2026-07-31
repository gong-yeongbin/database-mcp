// config.ts 의 DATABASE_URL 파싱과 환경변수 처리를 검증하는 테스트

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDatabaseUrl, loadConfig } from '../src/config.ts';

test('기본 URL 을 파싱한다', () => {
    const c = parseDatabaseUrl('mssql://sa:pw@localhost:1433/mydb');
    assert.equal(c.server, 'localhost');
    assert.equal(c.port, 1433);
    assert.equal(c.database, 'mydb');
    assert.equal(c.user, 'sa');
    assert.equal(c.password, 'pw');
});

test('포트가 없으면 1433 을 쓴다', () => {
    const c = parseDatabaseUrl('mssql://sa:pw@db.example.com/mydb');
    assert.equal(c.port, 1433);
    assert.equal(c.server, 'db.example.com');
});

test('비밀번호의 URL 인코딩을 해제한다', () => {
    // Str0ng!P@ss:word/x -> @ : / 가 인코딩된 형태
    const c = parseDatabaseUrl('mssql://sa:Str0ng%21P%40ss%3Aword%2Fx@localhost/mydb');
    assert.equal(c.password, 'Str0ng!P@ss:word/x');
    assert.equal(c.server, 'localhost');
    assert.equal(c.database, 'mydb');
});

test('사용자 이름의 URL 인코딩을 해제한다', () => {
    const c = parseDatabaseUrl('mssql://domain%5Cuser:pw@localhost/mydb');
    assert.equal(c.user, 'domain\\user');
});

test('encrypt 와 trustServerCertificate 는 기본이 true 다', () => {
    const c = parseDatabaseUrl('mssql://sa:pw@localhost/mydb');
    assert.equal(c.options?.encrypt, true);
    assert.equal(c.options?.trustServerCertificate, true);
});

test('query string 으로 encrypt 를 끌 수 있다', () => {
    const c = parseDatabaseUrl('mssql://sa:pw@localhost/mydb?encrypt=false&trustServerCertificate=false');
    assert.equal(c.options?.encrypt, false);
    assert.equal(c.options?.trustServerCertificate, false);
});

test('데이터베이스 이름이 없으면 거부한다', () => {
    assert.throws(() => parseDatabaseUrl('mssql://sa:pw@localhost:1433'), /데이터베이스 이름이 없습니다/);
    assert.throws(() => parseDatabaseUrl('mssql://sa:pw@localhost:1433/'), /데이터베이스 이름이 없습니다/);
});

test('사용자 이름이 없으면 거부한다', () => {
    assert.throws(() => parseDatabaseUrl('mssql://localhost:1433/mydb'), /사용자 이름이 없습니다/);
});

test('mssql 이 아닌 스킴은 거부한다', () => {
    assert.throws(() => parseDatabaseUrl('postgres://sa:pw@localhost/mydb'), /mssql:\/\/ 로 시작해야/);
});

test('URL 이 아니면 거부한다', () => {
    assert.throws(() => parseDatabaseUrl('Server=localhost;Database=mydb'), /형식이 올바르지 않습니다/);
});

test('DATABASE_URL 이 없으면 거부한다', () => {
    assert.throws(() => loadConfig({}), /DATABASE_URL 환경변수가 필요합니다/);
});

test("ALLOW_PROCEDURE 는 문자열 'true' 일 때만 참이다", () => {
    const url = 'mssql://sa:pw@localhost/mydb';
    assert.equal(loadConfig({ DATABASE_URL: url }).allowProcedure, false);
    assert.equal(loadConfig({ DATABASE_URL: url, ALLOW_PROCEDURE: 'true' }).allowProcedure, true);
    assert.equal(loadConfig({ DATABASE_URL: url, ALLOW_PROCEDURE: 'false' }).allowProcedure, false);
    assert.equal(loadConfig({ DATABASE_URL: url, ALLOW_PROCEDURE: '1' }).allowProcedure, false);
    assert.equal(loadConfig({ DATABASE_URL: url, ALLOW_PROCEDURE: 'TRUE' }).allowProcedure, false);
});

test('MAX_ROWS 기본값은 1000 이고 정수만 받는다', () => {
    const url = 'mssql://sa:pw@localhost/mydb';
    assert.equal(loadConfig({ DATABASE_URL: url }).maxRows, 1000);
    assert.equal(loadConfig({ DATABASE_URL: url, MAX_ROWS: '50' }).maxRows, 50);
    assert.throws(() => loadConfig({ DATABASE_URL: url, MAX_ROWS: '0' }), /1 이상의 정수/);
    assert.throws(() => loadConfig({ DATABASE_URL: url, MAX_ROWS: '-5' }), /1 이상의 정수/);
    assert.throws(() => loadConfig({ DATABASE_URL: url, MAX_ROWS: 'abc' }), /1 이상의 정수/);
    assert.throws(() => loadConfig({ DATABASE_URL: url, MAX_ROWS: '1.5' }), /1 이상의 정수/);
});
