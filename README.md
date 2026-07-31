# @dudqls816/database-mcp

Microsoft SQL Server 를 조회하는 MCP 서버. LLM 이 스키마를 탐색하고 쿼리를 실행할 수 있게 한다.

**`SELECT` 만 실행한다.** 임의 SQL 을 실행하는 tool 은 없다. 저장 프로시저 실행만
`ALLOW_PROCEDURE=true` 로 따로 열 수 있고, 이것이 유일하게 남은 쓰기 경로다.

## 목차

**쓰기 시작하려면** — [빠른 시작](#빠른-시작) · [업데이트](#업데이트) · [환경변수](#환경변수) · [Tool](#tool)

**프로시저를 켜려면** — [프로시저](#프로시저) · [켜기 전에 알아야 할 것](#켜기-전에-알아야-할-것)

**설정을 이해하려면** — [두 개의 층](#두-개의-층) · [스코프와 저장 위치](#스코프와-저장-위치)

**보안을 검토하려면** — [무엇이 실제로 통제되는가](#보안-무엇이-실제로-통제되는가) · [우회 가능한 경로](#우회-가능한-경로) · [permissions 로 좁히기](#permissions-로-좁히기) · [프로시저 DDL](#프로시저-ddl-은-어떻게-막히나) · [DB 권한으로 좁히기](#db-권한으로-좁히기)

**운영 중 걸리는 것** — [알아둘 것](#알아둘-것)

## 빠른 시작

**1. 읽기 전용 계정을 만든다.** 이것이 유일하게 우회 불가능한 통제다. 뒤에 나오는 설정은
전부 우회할 수 있다.

```sql
CREATE LOGIN mcp_ro WITH PASSWORD = 'Str0ng!Passw0rd';
USE mydb;
CREATE USER mcp_ro FOR LOGIN mcp_ro;
ALTER ROLE db_datareader ADD MEMBER mcp_ro;
```

**2. 서버를 등록한다.** 설치는 따로 하지 않는다. `npx` 가 패키지를 받아 실행한다.

CLI 로 등록하는 방법과 설정 파일을 직접 쓰는 방법이 있다. **결과는 같다** —
`claude mcp add` 는 아래 JSON 을 설정 파일에 써 넣는 편의 명령일 뿐이다.

**방법 A. CLI**

```bash
claude mcp add dudqls816-database -s local \
  -e DATABASE_URL='mssql://mcp_ro:Str0ng%21Passw0rd@localhost:1433/mydb' \
  -- npx -y @dudqls816/database-mcp
```

**방법 B. 설정 파일 직접 작성**

프로젝트 루트에 `.mcp.json` 을 만든다.

```json
{
  "mcpServers": {
    "dudqls816-database": {
      "command": "npx",
      "args": ["-y", "@dudqls816/database-mcp"],
      "env": {
        "DATABASE_URL": "mssql://mcp_ro:Str0ng%21Passw0rd@localhost:1433/mydb"
      }
    }
  }
}
```

`.mcp.json` 은 처음 열 때 승인 프롬프트가 뜨고, 승인 전에는 `claude mcp get` 에서
`⏸ Pending approval` 로 표시된다. 승인 없이 쓰려면 `~/.claude.json` 의
`projects["<프로젝트경로>"].mcpServers` 에 같은 내용을 넣는다(`-s local` 과 동일).

전역 설치를 선호하면 `npx` 대신 명령을 직접 쓴다.

```bash
npm i -g @dudqls816/database-mcp
claude mcp add dudqls816-database -s local \
  -e DATABASE_URL='mssql://mcp_ro:pw@localhost:1433/mydb' \
  -- dudqls816-database-mcp
```

**3. 확인한다.**

```bash
claude mcp get dudqls816-database    # ✔ Connected
```

DB 가 꺼져 있어도 `Connected` 로 나온다. 연결은 첫 tool 호출 때 이루어지므로 정상이다.

이제 "테이블 목록 보여줘", "users 테이블 구조", "최근 주문 10건" 처럼 요청하면 된다.
임의 SQL 을 실행하는 tool 은 애초에 존재하지 않는다.

## 업데이트

등록 방식에 따라 다르다.

| 방식 | 최신 버전 반영 |
| --- | --- |
| `npx` (방법 A, B) | 자동. 단 캐시가 남아 있는 동안은 이전 버전을 쓴다 |
| 전역 설치 | 수동. 직접 업데이트해야 한다 |

`npx` 는 받은 패키지를 캐시에 두고 재사용하므로 새 버전이 즉시 반영되지는 않는다.
바로 받으려면 `@latest` 를 붙여 실행한다.

```bash
npx -y @dudqls816/database-mcp@latest
```

전역 설치로 쓴다면 직접 올린다.

```bash
npm update -g @dudqls816/database-mcp
```

현재 배포된 버전과 설치된 버전은 이렇게 확인한다.

```bash
npm view @dudqls816/database-mcp version   # registry 의 최신 버전
npm ls -g @dudqls816/database-mcp          # 전역 설치된 버전
```

**Major 버전은 자동으로 넘어오지 않는다.** `npx` 는 `^0.1.0` 처럼 호환 범위로 캐시하므로
`0.x` 안에서는 알아서 올라가지만 `1.0.0` 은 그 범위 밖이다. Major 가 올라가면 tool 이름이나
설정이 바뀌었을 수 있으니, 릴리스 노트를 확인하고 위 `@latest` 명령으로 명시적으로 받는다.

## 환경변수

| 변수 | 필수 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `DATABASE_URL` | O | — | `mssql://user:password@host:1433/database` |
| `ALLOW_PROCEDURE` | X | `false` | `true` 일 때만 프로시저 tool 3개가 등록된다 |
| `MAX_ROWS` | X | `1000` | `query` 가 반환할 최대 행 수 |

`ALLOW_PROCEDURE` 는 `true` 라는 문자열만 인식한다. `TRUE`, `True`, `1`, `yes` 는 모두
`false` 로 읽힌다.

`ALLOW_PROCEDURE=true` 는 프로시저를 통한 쓰기를 가능하게 만든다. 아래 "프로시저" 절을
읽고 켜라.

`DATABASE_URL` 의 특수문자는 URL 인코딩한다. SQL Server 비밀번호에 `@` `:` `/` 가 흔하다.

```
Str0ng!P@ss  ->  mssql://sa:Str0ng%21P%40ss@localhost:1433/mydb
```

TLS 옵션은 query string 으로 조절한다. 둘 다 기본이 `true` 다.

```
mssql://sa:pw@localhost:1433/mydb?encrypt=false&trustServerCertificate=false
```

## Tool

| Tool | 설명 | 조건 |
| --- | --- | --- |
| `list_tables` | 모든 테이블과 뷰를 스키마와 함께 나열 | 항상 |
| `describe_table` | 컬럼, 자료형, NULL 허용, 기본값, 기본키 | 항상 |
| `query` | `SELECT` 한 문장 실행 | 항상 |
| `list_procedures` | 저장 프로시저를 스키마와 최종 수정일과 함께 나열 | `ALLOW_PROCEDURE=true` |
| `describe_procedure` | 프로시저의 파라미터 이름, 자료형, 입출력 방향 | `ALLOW_PROCEDURE=true` |
| `call_procedure` | `EXEC` 한 문장 실행 | `ALLOW_PROCEDURE=true` |

`query` 는 `@이름` 파라미터를 지원한다.

```json
{
  "sql": "SELECT * FROM orders WHERE customer_id = @cid AND status = @st",
  "params": { "cid": 42, "st": "paid" }
}
```

파라미터는 값만 바인딩한다. 테이블명과 컬럼명은 파라미터로 바꿀 수 없다.

## 프로시저

`ALLOW_PROCEDURE=true` 로 켜면 tool 3개가 등록된다.

```bash
claude mcp add dudqls816-database -s local \
  -e DATABASE_URL='mssql://user:pw@host:1433/mydb' \
  -e ALLOW_PROCEDURE=true \
  -- npx -y @dudqls816/database-mcp
```

`list_procedures` 와 `describe_procedure` 는 조회만 한다. 실행은 `call_procedure` 다.

```json
{ "sql": "EXEC dbo.GetOrders @userId = 42" }
```

`query` 와 달리 **파라미터를 바인딩하지 않는다.** 값을 `EXEC` 문장 안에 직접 써야 하므로
문자열은 따옴표를 이스케이프해야 한다. T-SQL 에서는 `'` 를 `''` 로 쓴다.

```json
{ "sql": "EXEC dbo.Search @name = 'O''Brien'" }
```

결과 집합과 영향받은 행 수를 함께 보고한다. 결과 집합이 여러 개면 첫 번째만 반환한다.

### 켜기 전에 알아야 할 것

**`call_procedure` 는 읽기 전용이 아니다.** 검사하는 것은 호출 문장의 형태뿐이다.

- `EXEC` 또는 `EXECUTE` 로 시작하는가
- 그 뒤에 **프로시저 이름(식별자)** 이 오는가
- 문장이 하나인가 (세미콜론으로 이어붙이기 차단)
- `sp_executesql`, `sp_sqlexec`, `xp_cmdshell` 이라는 이름이 있는가

이름 호출만 받으므로 아래는 거부된다. 임의 SQL 을 실행하는 형태다.

```sql
EXEC('DROP TABLE users')      -- 괄호 동적 SQL
EXEC N'DROP TABLE users'      -- 문자열 실행
EXEC @sql                     -- 변수 실행
```

**그러나 프로시저 본문은 검사하지 않는다.** 본문이 무엇을 하든 그대로 실행되므로
이 tool 을 통해 쓰기가 된다.

```sql
EXEC dbo.DeleteOldOrders      -- 본문의 DELETE 가 실행된다
EXEC sp_rename 'users', 'u2'  -- 차단 목록에 없는 시스템 프로시저
```

즉 이 스위치는 **쓰기를 여는 것**에 가깝다. `destructiveHint` 가 붙는 이유다.
프로시저를 쓰지 않는다면 켜지 않는다.

범위를 좁히려면 계정에 `EXECUTE` 를 통째로 주지 말고 필요한 프로시저에만 준다. 이것이
유일하게 확실한 통제다.

```sql
GRANT EXECUTE ON dbo.GetOrders TO mcp_ro;
```

이러면 다른 프로시저는 tool 을 통과해도 SQL Server 가 거부한다. 자세한 내용은
"보안: 무엇이 실제로 통제되는가" 를 참고하라.

## 두 개의 층

서버와 Claude Code `permissions` 는 **서로 다른 층**이라 둘 다 맞춰야 한다.

| 설정 | 저장 위치 | 담당 |
| --- | --- | --- |
| `-e ALLOW_PROCEDURE=` | `~/.claude.json` | 서버가 프로시저 tool 을 **등록할지** |
| `permissions` | `.claude/settings.local.json` | Claude Code 가 tool 호출을 **허용할지** |

**`claude mcp add` 는 `permissions` 를 건드리지 않는다.** `.claude/settings.local.json` 이
자동 생성되지 않으므로, 두 번째 자물쇠를 원하면 직접 만든다.

`.claude/settings.local.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__dudqls816-database__list_tables",
      "mcp__dudqls816-database__describe_table",
      "mcp__dudqls816-database__query"
    ],
    "deny": [
      "mcp__dudqls816-database__call_procedure"
    ]
  }
}
```

`deny` 가 `allow` 보다 우선하므로, 실수로 `ALLOW_PROCEDURE=true` 로 재등록해도
`call_procedure` 는 막힌다.

## 스코프와 저장 위치

`-s` 값에 따라 설정이 저장되는 곳이 다르다. `.mcp.json` 은 `-s project` 일 때만 생긴다.

| 스코프 | 저장 위치 | 범위 |
| --- | --- | --- |
| `-s local` (기본값) | `~/.claude.json` 의 `projects["<경로>"].mcpServers` | 이 프로젝트, 나만 |
| `-s user` | `~/.claude.json` 최상위 | 내 모든 프로젝트 |
| `-s project` | `<프로젝트루트>/.mcp.json` | git 에 커밋되어 팀 공유 |

> **`-s project` 주의**: `.mcp.json` 은 저장소에 커밋되고 `env` 의 비밀번호가 평문으로 들어간다.
> 혼자 쓴다면 `-s local` 또는 `-s user` 를 쓴다.

```bash
claude mcp get dudqls816-database
claude mcp list
claude mcp remove dudqls816-database -s local
```

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` 에 직접 쓴다.
`.mcp.json` 을 손으로 쓸 때도 같은 형식이다.

```json
{
  "mcpServers": {
    "dudqls816-database": {
      "command": "npx",
      "args": ["-y", "@dudqls816/database-mcp"],
      "env": {
        "DATABASE_URL": "mssql://mcp_ro:pw@localhost:1433/mydb"
      }
    }
  }
}
```

## 보안: 무엇이 실제로 통제되는가

**쓰기 차단은 편의 기능이고, 실제 통제는 DB 계정이다.**

임의 SQL 을 실행하는 tool 은 등록 자체가 되지 않는다. `query` 는 여러 문장,
`SELECT`/`WITH` 로 시작하지 않는 문장, 쓰기 키워드를 거부한다. 다만 문자열 검사로 T-SQL 의
모든 부수 효과를 막을 수는 없다. **이 가드는 LLM 의 실수를 막는 장치이고 보안 경계가 아니다.**

### 우회 가능한 경로

`ALLOW_PROCEDURE` 와 `permissions` 는 **이 MCP 서버를 통한 호출만** 막는다. 접속 문자열을 읽을 수
있는 프로세스는 그 계정 권한 전부를 행사할 수 있다. 그리고 서버를 통한 호출 중에도
가드를 빠져나가는 경로가 있다(7~8번).

**1. 기본 설치 상태에는 `permissions` 가 없다.**
`.claude/settings.local.json` 은 설치 시 자동 생성되지 않는다. 직접 작성하지 않으면
서버가 등록하는 tool 목록 자체가 유일한 통제 수단이다.

**2. 셸에서 직접 접속**
접속 문자열만 있으면 아무 클라이언트로나 붙을 수 있다. `sqlcmd`, DBeaver, TablePlus,
또는 스크립트 몇 줄이면 된다.

```bash
sqlcmd -S localhost,1433 -U sa -P pw -Q "DELETE FROM users"
```

**3. 서버를 다른 설정으로 직접 실행**

```bash
DATABASE_URL='...' ALLOW_PROCEDURE=true npx @dudqls816/database-mcp
```

**4. 설정 파일 수정**
`.claude/settings.local.json` 에서 `deny` 를 지우거나, `claude mcp remove` 후
`ALLOW_PROCEDURE=true` 로 재등록하면 된다.

**5. 다른 MCP 서버 경유**
`deny` 규칙은 `mcp__dudqls816-database__*` 라는 이름에만 걸린다. DB 에 접근하는 다른 서버는 통제 밖이다.

**6. 접속 정보 노출**
`DATABASE_URL` 은 `~/.claude.json` 에 평문으로 저장된다. `-s project` 로 등록했다면
`.mcp.json` 이 git 에 커밋되어 저장소 접근자 전원이 볼 수 있다.

여기까지는 서버 **바깥에서** 우회하는 경로다. 아래는 서버를 정상적으로 쓰면서
읽기 전용 전제를 벗어나는 경로다.

**7. `ALLOW_PROCEDURE=true` 는 남은 유일한 쓰기 경로다.**
켜면 `call_procedure` 가 등록되고, 이 tool 은 호출 문장의 형태만 검사한다. **프로시저 본문이
무엇을 하는지는 검사하지 않는다.** 데이터를 바꾸는 프로시저가 하나라도 있으면 그것으로
쓰기가 된다. 차단되는 형태와 통과하는 형태는
["켜기 전에 알아야 할 것"](#켜기-전에-알아야-할-것)에 정리해 두었다.

여기에 더해 시스템 프로시저로 권한 자체를 바꿀 수도 있다.

```sql
EXEC sp_addrolemember 'db_owner', 'mcp_ro'    -- 권한 상승
```

프로시저를 쓰지 않는다면 켜지 않는다. 범위를 좁히려면 `GRANT EXECUTE` 를 프로시저별로 준다.

**8. `query` 의 키워드 검사는 문자열 매칭이다.**
`assertReadOnly` 는 주석과 문자열 리터럴을 제거한 뒤 `SELECT` 또는 `WITH` 로 시작하는지 보고
쓰기 키워드가 있는지 본다. 이 검사를 통과하면서 읽기 범위를 벗어나는 SQL 이 존재한다.
아래는 모두 현재 가드를 **통과한다**.

```sql
SELECT * FROM OPENROWSET('SQLNCLI', '...', 'SELECT 1')  -- 외부 데이터 원본
SELECT * FROM OPENQUERY(linked_server, 'SELECT 1')      -- 링크드 서버 경유
SELECT dbo.SideEffectFn(1)                              -- 부수 효과가 있는 사용자 함수
SELECT * FROM sys.sql_logins                            -- 시스템 카탈로그 열람
```

키워드 목록(`INSERT`, `UPDATE`, `DELETE`, `EXEC`, `DROP` 등)에 없는 수단은 걸러지지 않는다.
목록을 늘려도 근본적으로 파서가 아니라 문자열 검사이므로 완전해질 수 없다.

정리하면 이렇다.

| 통제 | 우회 |
| --- | --- |
| `permissions` 의 `deny` | 1~6 전부 |
| 임의 SQL tool 부재 | 1~6 전부, 그리고 7 (`ALLOW_PROCEDURE`) |
| `query` 의 읽기 전용 가드 | 8 |
| **DB 계정 권한** | **없음** |

### `permissions` 로 좁히기

우회를 좁히는 데는 두 층이 있다. **`permissions` 층은 Claude 가 실행하는 것만** 막고,
사용자가 터미널에 직접 치는 것은 막지 못한다. **[DB 권한 층](#db-권한으로-좁히기)이 실제 통제다.**

이 절은 `permissions` 층을 `ALLOW_PROCEDURE` 값에 따라 두 경우로 나눠 보인다.

**경우 1. `ALLOW_PROCEDURE=false`**

등록되는 tool 은 `list_tables`, `describe_table`, `query` 셋뿐이고 프로시저 tool 은
존재하지 않는다.

| # | 경로 | `permissions` | DB 권한 |
| --- | --- | --- | --- |
| 1 | 셸에서 직접 접속 | `Bash(sqlcmd:*)`, `Bash(node:*)` 등 | O |
| 2 | 다른 설정으로 재실행 | `Bash(*ALLOW_PROCEDURE*)` 등 | O |
| 3 | 설정 파일 수정·재등록 | `Bash(claude mcp add:*)` 등 | O |
| 4 | 다른 MCP 서버 경유 | 그 서버의 tool 이름을 `deny` | O |
| 5 | 접속 정보 노출 | `Read(~/.claude.json)` | `-s project` 를 쓰지 않는다 |
| 6 | `query` 안의 `OPENQUERY` 등 | **불가** | O |

**6번은 `permissions` 로 막을 수 없다.** `deny` 는 tool 이름에만 걸리고 SQL 문자열은 보지 않는다.
`query` 를 통째로 `deny` 하면 막히지만 그러면 이 서버를 쓰는 의미가 없어진다.

`.claude/settings.local.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__dudqls816-database__list_tables",
      "mcp__dudqls816-database__describe_table",
      "mcp__dudqls816-database__query"
    ],
    "deny": [
      "mcp__dudqls816-database__call_procedure",

      "Bash(sqlcmd:*)",
      "Bash(mssql-cli:*)",
      "Bash(bcp:*)",
      "Bash(isql:*)",
      "Bash(osql:*)",

      "Bash(node:*)",
      "Bash(python:*)",
      "Bash(python3:*)",
      "Bash(npx:*)",
      "Bash(tsx:*)",
      "Bash(deno:*)",
      "Bash(bun:*)",

      "Bash(claude mcp add:*)",
      "Bash(claude mcp remove:*)",
      "Bash(*ALLOW_PROCEDURE*)",
      "Read(~/.claude.json)",
      "Read(.mcp.json)"
    ]
  }
}
```

`call_procedure` 는 지금 등록조차 되지 않지만 `deny` 에 미리 넣어 둔다. 나중에
`ALLOW_PROCEDURE=true` 로 재등록해도 `deny` 가 `allow` 보다 우선하므로 막힌다.

**런타임을 통째로 막는 이유**

두 번째 묶음(`node`, `python`, `npx` 등)이 **가장 중요하다.** DB 클라이언트 CLI 를 다
막아도 런타임이 열려 있으면 한 줄로 뚫린다. 이 서버를 설치한 프로젝트에는 `mssql`
드라이버가 이미 `node_modules` 에 들어 있다.

```bash
node -e "const sql=require('mssql'); ..."   # sqlcmd 없이도 쓰기가 된다
python -c "import pymssql; ..."
npx @dudqls816/database-mcp                        # 서버를 다른 설정으로 재실행
```

**부작용을 알고 넣어야 한다.** `node` 와 `python` 을 막으면 Claude 가 `npm test`,
`npm run build`, `tsc`, `node dist/index.js` 를 실행할 수 없다. 즉 위 목록은
**DB 를 조회만 하는 프로젝트용**이다. 이 MCP 서버나 다른 Node 프로젝트를 개발하는
저장소에 그대로 넣으면 개발이 막힌다. 개발 저장소라면 런타임 묶음은 빼고 CLI 묶음만 쓴다.

`Bash(node -e:*)`, `Bash(python -c:*)` 처럼 좁혀 막는 방법도 있다. 그러면 `npm test` 는
살아남지만, 스크립트를 파일로 저장해서 `node script.js` 로 실행하면 통과한다.
**좁히면 개발은 되지만 층이 얇아진다.** 어느 쪽이든 아래 한계는 그대로다.

`Bash(*ALLOW_PROCEDURE*)` 도 완전하지 않다. 명령 문장에 그 이름이 보일 때만 걸리므로,
`export ALLOW_PROCEDURE=true` 를 먼저 실행한 뒤 서버를 띄우면 패턴에 걸리지 않는다.

이 `Bash` 규칙 전체가 얇은 층이다. 목록을 다 넣어도 아래는 남는다.

- `/usr/bin/sqlcmd` 처럼 절대 경로로 부르면 이름 패턴을 빠져나간다
- DBeaver, TablePlus 같은 GUI 클라이언트는 `Bash` 를 쓰지 않는다
- 사용자가 터미널에 직접 치는 것은 `permissions` 와 무관하다

**Claude 의 무심코 하는 우회를 막는 용도이지 의도적 우회를 막지 못한다.**

**경우 2. `ALLOW_PROCEDURE=true`**

프로시저를 써야 해서 켰다면, **쓰기 경로를 `call_procedure` 하나로 좁히는 것**이 목표가 된다.
그 tool 만 남기고 다른 우회 경로는 모두 닫는다.

위 목록과 다른 점은 `call_procedure` 를 `deny` 에서 빼고 `allow` 로 옮기는 것이다.
`Bash` 와 `Read` 규칙은 그대로 유지한다. 오히려 이때 더 중요하다. `Bash` 가 열려 있으면
프로시저 하나만 허용한다는 전제 자체가 무의미해진다.

```json
{
  "permissions": {
    "allow": [
      "mcp__dudqls816-database__list_tables",
      "mcp__dudqls816-database__describe_table",
      "mcp__dudqls816-database__query",
      "mcp__dudqls816-database__list_procedures",
      "mcp__dudqls816-database__describe_procedure",
      "mcp__dudqls816-database__call_procedure"
    ],
    "deny": [
      "Bash(sqlcmd:*)",
      "Bash(mssql-cli:*)",
      "Bash(bcp:*)",
      "Bash(isql:*)",
      "Bash(osql:*)",

      "Bash(node:*)",
      "Bash(python:*)",
      "Bash(python3:*)",
      "Bash(npx:*)",
      "Bash(tsx:*)",
      "Bash(deno:*)",
      "Bash(bun:*)",

      "Bash(claude mcp add:*)",
      "Bash(claude mcp remove:*)",
      "Read(~/.claude.json)",
      "Read(.mcp.json)"
    ]
  }
}
```

`Bash(*ALLOW_PROCEDURE*)` 는 빠졌다. 이미 켜서 쓰는 상황이므로 그 패턴을 막으면
정상적인 재등록도 막힌다.

`list_procedures` 와 `describe_procedure` 는 `readOnlyHint` 인 조회 tool 이라 함께 허용한다.
이것이 없으면 프로시저 이름과 파라미터를 모르는 채로 `call_procedure` 를 써야 한다.

### 프로시저 DDL 은 어떻게 막히나

`call_procedure` 는 프로시저를 **실행**할 뿐이다. 프로시저 정의를 바꾸는
`CREATE` / `ALTER` / `DROP PROCEDURE` 는 이 tool 로 실행되지 않는다. `assertProcedureCall`
이 `EXEC` 로 시작하는 문장만 통과시키기 때문이다. `query` tool 로도 안 된다.
`assertReadOnly` 의 `FORBIDDEN` 목록에 `CREATE` / `ALTER` / `DROP` 이 있어 거부된다.

즉 프로시저 DDL 은 **MCP 의 어떤 tool 로도 실행할 수 없다.** 남는 경로는 tool 을
거치지 않는 것뿐이다. `sqlcmd`, `node -e`, `python` 으로 드라이버를 직접 부르는 것이다.

```bash
sqlcmd -S host -U user -P pw -Q "DROP PROCEDURE dbo.GetOrders"
node -e "const sql=require('mssql'); ... request().batch('ALTER PROCEDURE dbo.GetOrders ...')"
```

이 경로는 위 `deny` 목록의 `Bash(sqlcmd:*)`, `Bash(node:*)`, `Bash(python:*)` 등이
이미 막는다. 프로시저 DDL 을 위해 따로 추가할 `deny` 규칙은 없다. tool 이름이 아니라
런타임과 CLI 를 막는 것이기 때문이다. 다만 절대 경로 호출과 GUI 클라이언트는
그대로 빠져나가므로, 확실한 통제는 아래 DB 권한 층이다.

### DB 권한으로 좁히기

**유일하게 우회 불가능한 통제다.** 위 두 경우 모두 `permissions` 는 tool 이름에만 걸린다. `EXEC` 뒤의 프로시저 이름도,
`query` 안의 SQL 문자열도 보지 못한다. 그래서 `call_procedure` 를 허용하는 순간
**그 계정이 실행할 수 있는 모든 프로시저**가 열리고, `GetOrders` 만 허용하고
`DeleteOldOrders` 는 막는 구분은 `permissions` 로 할 수 없다. 그 구분은 DB 에서만 된다.

읽기 전용이면 "빠른 시작" 의 `db_datareader` 로 충분하다. 더 좁히려면 테이블별로 준다.

```sql
CREATE LOGIN mcp_ro WITH PASSWORD = 'Str0ng!Passw0rd';
USE mydb;
CREATE USER mcp_ro FOR LOGIN mcp_ro;

-- 필요한 테이블에만 읽기를 준다. 넓게 주려면 db_datareader 를 쓴다.
GRANT SELECT ON dbo.orders   TO mcp_ro;
GRANT SELECT ON dbo.products TO mcp_ro;

-- 다른 DB 와 시스템 카탈로그를 가린다
DENY VIEW ANY DATABASE   TO mcp_ro;
DENY VIEW ANY DEFINITION TO mcp_ro;
```

프로시저를 쓴다면(`ALLOW_PROCEDURE=true`) `EXECUTE` 를 통째로 주지 말고 프로시저별로 준다.
`db_datareader` 에는 `EXECUTE` 가 포함되지 않으므로 필요한 것만 따로 준다.

```sql
GRANT EXECUTE ON dbo.GetOrders   TO mcp_ro;
GRANT EXECUTE ON dbo.GetProducts TO mcp_ro;
```

이러면 목록에 없는 프로시저는 tool 을 통과해도 SQL Server 가 거부한다.
`sp_rename`, `sp_addrolemember` 같은 시스템 프로시저도 함께 막힌다. 반대로 `GRANT EXECUTE`
를 하나도 하지 않으면 `ALLOW_PROCEDURE=true` 로 켜도 모든 호출이 서버에서 거부된다.
tool 은 등록되지만 실행은 되지 않아, 목록과 파라미터만 보고 싶을 때 쓸 수 있는 조합이다.

`GRANT EXECUTE` 는 **실행 권한만** 준다. 프로시저 정의를 바꾸는 `ALTER` / `DROP PROCEDURE` 는
포함되지 않으므로, 이 계정으로는 Bash 를 거쳐 직접 붙어도 프로시저를 수정·삭제할 수 없다.
굳이 명시하려면 거부한다.

```sql
DENY ALTER, CONTROL ON dbo.GetOrders TO mcp_ro;
```

`OPENROWSET`(우회 8번)은 서버 수준 설정으로 끈다. `EXECUTE` 를 주지 않으면 같은 8번의
사용자 함수 호출도 함께 막힌다.

```sql
EXEC sp_configure 'Ad Hoc Distributed Queries', 0;
RECONFIGURE;
```

**따라서 실효성 있는 통제는 DB 계정 하나뿐이다.** 이 계정을 쓰면 위 우회 경로를 모두
시도해도 SQL Server 가 거부한다. `permissions` 의 `Bash`/`Read` 규칙은 Claude 의 무심한
우회를 막는 보조 층일 뿐이다.

## 알아둘 것

**DB 연결은 첫 tool 호출 때 이루어진다.**
DB 가 꺼져 있어도 서버는 정상 시작하고 `claude mcp get` 이 `✔ Connected` 로 나온다. 연결
실패는 tool 에러로 보고되고 DB 가 복구되면 다음 호출에서 회복된다.

**행 상한은 출력만 줄이고 서버 작업량은 줄이지 않는다.**
`SELECT * FROM huge_table` 은 SQL Server 가 여전히 전체 결과를 만든다. 큰 테이블은 `TOP` 이나
`WHERE` 로 직접 좁힌다. 30초 타임아웃이 걸려 있다.

**DECIMAL / NUMERIC 은 조용히 손실될 수 있다.**
JS `number` 로 변환되므로 2^53 을 넘거나 scale 이 큰 값은 에러 없이 틀린다. 금액 컬럼은
`SELECT CAST(amount AS VARCHAR(50)) AS amount` 처럼 캐스팅한다.

**결과 집합이 여러 개면 첫 번째만 반환한다.** 그 사실을 응답에 명시한다.
