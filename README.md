# prfix

PR diff를 로컬에서 GitHub처럼 보고, 코드 라인에 코멘트를 달면 지정한 에이전트가 워크트리에서 고쳐 커밋·머지까지 끝내는 리뷰 툴.

[difit](https://github.com/yoshiko-pg/difit) (MIT) 포크. diff 뷰어·코멘트 UI·PR 로딩은 difit 것을 그대로 쓰고, `/fp` 트리거 → 에이전트 실행 → git 파이프라인 → 상태 UI를 얹었다. 업스트림 문서는 `README.ja.md` / `README.ko.md` / `README.zh.md`에 그대로 남아 있다.

## 필요한 것

| 도구                                                      | 용도                                           |
| --------------------------------------------------------- | ---------------------------------------------- |
| `gh` (인증 완료)                                          | PR diff·메타데이터 조회                        |
| `git`                                                     | 워크트리, 커밋, 머지, 푸시                     |
| [`grove`](https://github.com/miridih/cp-grove-cli) (선택) | PR 워크트리 생성. 없으면 `git worktree`로 대체 |
| `claude` / `codex`                                        | 실제로 코드를 고치는 에이전트                  |

Node 21+, pnpm.

```bash
pnpm install
pnpm build
node dist/cli/index.js --pr https://github.com/owner/repo/pull/123
```

## 사용법

로컬 클론 안에서 실행한다.

```bash
prfix --pr https://github.com/owner/repo/pull/123
```

1. `gh pr diff`로 PR diff를 읽어 브라우저에 띄운다
2. PR head 브랜치 워크트리를 확보한다 — `grove init <PR URL>`, 없으면 `git worktree add`
3. 코드 라인에 코멘트를 달고, 본문을 `/fp`로 시작하면 에이전트가 수정에 들어간다

```
/fp --agent claude@opus5
이 조건문 early return으로 바꿔줘
```

코멘트 입력창의 **🤖 Fix with agent** 버튼을 쓰면 트리거 줄이 자동으로 붙는다.

### 트리거 문법

```
/fp [--agent <provider>@<model>] [--no-merge] [--dry-run]
<지시문>
```

| 플래그          | 뜻                                                |
| --------------- | ------------------------------------------------- |
| `--agent`, `-a` | 이 작업을 처리할 에이전트. 생략하면 설정의 기본값 |
| `--no-merge`    | 커밋까지만 하고 fp 브랜치·워크트리를 남긴다       |
| `--dry-run`     | 에이전트 대신 스텁을 돌려 파이프라인만 검증한다   |

`/fix-pr`도 alias로 인식한다.

### 작업이 하는 일

코멘트 스레드 하나가 작업 하나다.

1. `origin/<head>`에서 `fp/<head>/<taskId>` 브랜치로 워크트리 생성
2. 파일·라인·코드·코멘트를 담은 프롬프트로 에이전트 실행 (지적 범위만 수정, 커밋 금지)
3. 변경이 없으면 `no-change`로 끝내고 워크트리 정리
4. 변경이 있으면 **스레드당 1커밋**

   ```
   fix(review): <지시문 첫 줄>

   thread: <threadId>
   file: <path>:<line>
   agent: <provider>@<model>
   ```

5. 리뷰 워크트리의 **로컬** head 브랜치에 `merge --no-ff`
6. fp 워크트리·브랜치 정리, 결과를 스레드에 로컬 답글로 남김

작업 큐는 **직렬**이다. 모두 같은 head 브랜치에 머지하므로 병렬로 돌리면 충돌이 난다.

실패하면 워크트리와 브랜치를 남기고 상태를 `failed`로 둔다. 해당 워크트리에서 이어서 손보면 된다. 머지 충돌도 같다 — 머지를 되돌리고 수정 커밋은 `fp/...` 브랜치에 남긴다.

### push는 사용자가 한 번에

작업은 **로컬 head 브랜치까지만** 반영한다. 리모트로 올리는 시점은 헤더의 **⬆ Push (N)** 버튼을 누를 때 하나뿐이다. N은 `origin/<head>`보다 앞선 커밋 수다.

그래서 여러 코멘트를 연달아 처리하고 diff로 결과를 확인한 뒤, 마음에 들 때 한 번에 PR에 올릴 수 있다. 작업마다 바로 올리려면 설정에서 `autoPush`를 켠다.

### diff는 로컬 git에서 나온다

PR diff를 `gh pr diff` 스냅샷으로 한 번 받아오는 게 아니라, 리뷰 워크트리에서 `merge-base(origin/<base>, HEAD)..HEAD`로 계산한다. 그래서 에이전트가 커밋하면 파일 워처가 이를 감지해 **Refresh 버튼**이 뜨고, 누르면 수정 결과가 바로 diff에 반영된다.

워크트리를 준비하지 못했을 때만 `gh pr diff` 스냅샷으로 물러난다 (이 경우 `/fp`도 비활성).

### 링크에 담긴 범위만 보기

GitHub에서 "Changes from" 드롭다운이나 커밋을 눌러 나온 URL을 그대로 넘기면, 그 범위만 로컬에서 계산해 띄운다.

| 링크                       | 로컬 diff                               | `/fp`  |
| -------------------------- | --------------------------------------- | ------ |
| `/pull/N`, `/pull/N/files` | `merge-base(origin/<base>, HEAD)..HEAD` | 가능   |
| `/pull/N/files/<sha>`      | `<sha>..HEAD` (그 커밋 이후의 변경)     | 가능   |
| `/pull/N/files/<a>..<b>`   | `<a>..<b>`                              | 비활성 |
| `/pull/N/commits/<sha>`    | `<sha>^..<sha>` (그 커밋 하나)          | 비활성 |

target이 head tip이 아니면 화면의 라인 번호가 head와 어긋나 엉뚱한 줄을 고칠 수 있으므로 `/fp`를 막는다. 파일 워처도 그때는 꺼진다.

링크의 SHA가 로컬에 없으면 `refs/pull/<N>/head`로 받아온다. force-push로 사라진 커밋도 대체로 이걸로 잡힌다.

### GitHub에 쓰지 않는다

prfix는 GitHub을 **읽기만** 한다 (PR 메타데이터, 기존 리뷰 코멘트 가져오기). 로컬 코멘트도, `/fp` 처리 결과도 PR에 코멘트로 올리지 않는다. PR에 드러나는 것은 Push 버튼으로 올린 커밋뿐이다.

Fork에서 올라온 PR은 head 브랜치가 origin에 없어 지원하지 않는다.

## CLI 옵션 (prfix 추가분)

| 옵션            | 설명                                              |
| --------------- | ------------------------------------------------- |
| `--agent <ref>` | 이 세션의 기본 에이전트                           |
| `--dry-run`     | 모든 `/fp` 작업을 스텁으로 실행                   |
| `--no-worktree` | 워크트리 준비를 건너뛴다 (에이전트 수정 비활성화) |

나머지 옵션은 difit과 같다.

## 설정

### `~/.config/prfix/config.json`

```json
{
  "defaultAgent": "claude@opus5",
  "triggerTokens": ["/fp", "/fix-pr"],
  "postFixCommands": ["pnpm lint --fix"],
  "autoMerge": true,
  "autoPush": false
}
```

| 키          | 뜻                                                                       |
| ----------- | ------------------------------------------------------------------------ |
| `autoMerge` | `false`면 작업이 커밋까지만 하고 로컬 head 머지도 사용자가 직접 한다     |
| `autoPush`  | `true`면 작업마다 바로 `origin`에 push한다. 기본은 Push 버튼으로 한 번에 |

### `~/.config/prfix/agents.json`

provider 단위로 실행 커맨드를 덮어쓴다. `{{MODEL}}`은 해석된 모델명으로 치환되고, `{{PROMPT}}`가 있으면 프롬프트를 인자로, 없으면 stdin으로 넘긴다.

```json
{
  "providers": {
    "codex": {
      "command": "codex",
      "args": ["exec", "-m", "{{MODEL}}", "-s", "workspace-write", "--approve-for-me"],
      "suggestedModels": ["astro6", "sol6"]
    }
  }
}
```

모델 이름은 alias 테이블에 없으면 그대로 CLI에 넘어간다. 새 모델이 나와도 코드를 고칠 필요가 없다.

기본 매핑:

| ref                  | 실행                                                                             |
| -------------------- | -------------------------------------------------------------------------------- |
| `claude@opus5`       | `claude -p --model opus --permission-mode acceptEdits`                           |
| `claude@sonnet5`     | `claude -p --model sonnet ...`                                                   |
| `codex@astro6`       | `codex exec -m astro6 -s workspace-write --approve-for-me --skip-git-repo-check` |
| `<provider>@default` | 모델 플래그를 빼고 CLI 자체 기본 모델을 쓴다                                     |

## API

difit API에 더해:

| 메서드 | 경로                              | 용도                                                       |
| ------ | --------------------------------- | ---------------------------------------------------------- |
| GET    | `/api/agents`                     | 에이전트 목록·기본값·트리거 토큰                           |
| GET    | `/api/agent-tasks`                | 작업 목록·상태                                             |
| POST   | `/api/agent-tasks`                | `{ threadId, agentRef?, instruction?, noMerge?, dryRun? }` |
| POST   | `/api/agent-tasks/:taskId/cancel` | 취소                                                       |
| GET    | `/api/push-status`                | `origin/<head>` 대비 안 올라간 커밋 수                     |
| POST   | `/api/push`                       | head 브랜치를 push                                         |

진행 상황은 기존 `/api/watch` SSE에 `agentTaskChanged` 이벤트로 흐른다.

## 개발

```bash
pnpm test          # vitest
pnpm check         # oxlint (type-aware)
pnpm format:fix    # oxfmt
pnpm build
```

prfix가 추가한 파일:

```
src/cli/worktree.ts             grove/git 워크트리 확보
src/cli/pr-range.ts             PR 링크의 비교 범위 파싱
src/server/trigger-parser.ts    /fp 파싱
src/server/agent-registry.ts    provider@model → 실행 커맨드
src/server/agent-runner.ts      직렬 작업 큐
src/server/fix-pipeline.ts      워크트리·커밋·머지·푸시·정리
src/server/prfix-config.ts      설정 로더
src/client/hooks/useAgentTasks.ts
src/client/contexts/AgentTasksContext.tsx
src/client/components/AgentTaskBadge.tsx
src/client/components/AgentTaskPanel.tsx
src/client/components/PushToPrButton.tsx
```

업스트림 difit을 따라가려면:

```bash
git fetch upstream
git rebase upstream/main
```
