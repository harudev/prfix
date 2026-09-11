# prfix

GitHub PR을 로컬에서 리뷰하고, 코드 라인에 단 코멘트를 코딩 에이전트가 받아 고쳐주는 툴.

웹 GitHub에서 지적 사항을 읽고 → 터미널로 옮겨 워크트리를 만들고 → 프롬프트를 다시 쓰는 왕복을 없앤다. 브라우저에서 라인에 코멘트를 달면 에이전트가 워크트리에서 그 줄만 고쳐 커밋하고, PR에 올리는 시점은 사용자가 버튼으로 정한다.

## 설치

### 1. 사전 준비

| 도구                                                      | 용도                                           | 확인               |
| --------------------------------------------------------- | ---------------------------------------------- | ------------------ |
| `gh`                                                      | PR 메타데이터·리뷰 코멘트 조회                 | `gh auth status`   |
| `git`                                                     | 워크트리·커밋·머지·푸시                        | `git --version`    |
| `claude` 또는 `codex`                                     | 실제로 코드를 고치는 에이전트                  | `claude --version` |
| [`grove`](https://github.com/miridih/cp-grove-cli) (선택) | PR 워크트리 생성. 없으면 `git worktree`로 대체 | `grove version`    |

Node 21+, pnpm 필요.

### 2. 빌드하고 전역 명령으로 등록

```bash
git clone git@github.com:harudev/prfix.git ~/projects/prfix
cd ~/projects/prfix
pnpm install
pnpm build
pnpm link --global
```

`prfix --version`이 나오면 끝이다. 전역 bin은 `$PNPM_HOME`(기본 `~/Library/pnpm`)에 깔리므로 그 경로가 `PATH`에 있어야 한다.

전역 등록 없이 쓰려면 경로로 직접 실행해도 된다.

```bash
node ~/projects/prfix/dist/cli/index.js --pr <PR URL>
```

### 3. 기본 에이전트 지정 (선택)

```bash
mkdir -p ~/.config/prfix
cat > ~/.config/prfix/config.json <<'JSON'
{
  "defaultAgent": "claude@opus5"
}
JSON
```

안 만들면 `claude@opus5`가 기본값이다.

### 업데이트

```bash
cd ~/projects/prfix && git pull && pnpm install && pnpm build
```

`pnpm link --global`은 다시 할 필요 없다.

## 사용법

**리뷰할 저장소의 로컬 클론 안에서** 실행한다. PR head 브랜치 워크트리를 그 저장소 기준으로 찾기 때문이다.

```bash
cd ~/projects/my-repo
prfix --pr https://github.com/owner/my-repo/pull/123
```

브라우저가 열리고 GitHub Files changed와 같은 diff가 뜬다. 동시에 PR head 브랜치 워크트리가 준비된다 — 이미 있으면 재사용하고, 없으면 `grove init`(없으면 `git worktree add`)으로 만든다.

### 코멘트로 수정 요청하기

1. 코드 라인에 마우스를 올리면 줄 번호 옆에 **`+`** 버튼이 뜬다 (여러 줄은 드래그)
2. 지시문을 쓴다
3. 입력창 아래 드롭다운에서 에이전트를 고르고 **🤖 Fix with agent**를 누른다

그냥 **Submit**을 누르면 로컬 메모로만 남고 에이전트는 돌지 않는다. 버튼 대신 본문 첫 줄에 트리거를 직접 써도 된다.

```
/fp --agent claude@opus5
이 조건문 early return으로 바꿔줘
```

제출하는 순간 작업이 큐에 들어간다. 스레드에 상태 배지(`대기` → `실행 중` → `머지됨`)가 붙고, 배지를 누르면 에이전트 로그가 펼쳐진다. 끝나면 커밋 SHA와 변경 파일이 답글로 달린다.

### 트리거 문법

```
/fp [--agent <provider>@<model>] [--no-merge] [--dry-run]
<지시문>
```

| 플래그          | 뜻                                                  |
| --------------- | --------------------------------------------------- |
| `--agent`, `-a` | 이 작업을 처리할 에이전트. 생략하면 설정의 기본값   |
| `--no-merge`    | 커밋까지만 하고 `fp/...` 브랜치와 워크트리를 남긴다 |
| `--dry-run`     | 에이전트 대신 스텁을 돌려 파이프라인만 확인한다     |

`/fix-pr`도 alias로 인식한다. 트리거는 **새로 다는 코멘트**에만 걸린다 — 기존 코멘트를 수정해 트리거를 붙이면 동작하지 않는다.

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
6. fp 워크트리·브랜치 정리, 결과를 스레드에 답글로 남김

작업 큐는 **직렬**이다. 모두 같은 head 브랜치에 머지하므로 병렬로 돌리면 충돌이 난다.

실패하면 워크트리와 `fp/...` 브랜치를 남기고 상태를 `failed`로 둔다. 그 워크트리에서 이어서 손보면 된다. 머지 충돌도 같다 — 머지를 되돌리고 수정 커밋은 브랜치에 남긴다.

### PR에 올리는 시점

작업은 **로컬 head 브랜치까지만** 반영한다. 리모트로 올라가는 순간은 헤더의 **⬆ Push (N)** 버튼 하나뿐이다. N은 `origin/<head>`보다 앞선 커밋 수고, 누르면 확인창이 한 번 뜬다.

그래서 코멘트 여러 개를 연달아 처리하고 diff로 결과를 본 뒤, 마음에 들 때 한 번에 올릴 수 있다. 마음에 안 들면 워크트리에서 `git reset`으로 버리면 그만이다.

작업마다 바로 올리려면 설정에서 `autoPush`를 켠다.

### 링크에 담긴 범위만 보기

GitHub의 "Changes from" 드롭다운이나 커밋을 눌러 나온 URL을 그대로 넘기면, 그 범위만 계산해 띄운다.

| 링크                       | 로컬 diff                               | `/fp`  |
| -------------------------- | --------------------------------------- | ------ |
| `/pull/N`, `/pull/N/files` | `merge-base(origin/<base>, HEAD)..HEAD` | 가능   |
| `/pull/N/files/<sha>`      | `<sha>..HEAD` (그 커밋 이후의 변경)     | 가능   |
| `/pull/N/files/<a>..<b>`   | `<a>..<b>`                              | 비활성 |
| `/pull/N/commits/<sha>`    | `<sha>^..<sha>` (그 커밋 하나)          | 비활성 |

target이 head tip이 아니면 화면의 라인 번호가 head와 어긋나 엉뚱한 줄을 고칠 수 있으므로 `/fp`를 막는다.

링크의 SHA가 로컬에 없으면 `refs/pull/<N>/head`로 받아온다. force-push로 브랜치에서 떨어져 나간 커밋도 대체로 이걸로 잡힌다.

### diff는 로컬 git에서 나온다

PR diff를 한 번 받아와 고정하는 게 아니라, 리뷰 워크트리에서 매번 계산한다. 그래서 에이전트가 커밋하면 파일 워처가 감지해 **Refresh 버튼**이 뜨고, 누르면 수정 결과가 바로 diff에 반영된다.

워크트리를 준비하지 못했을 때만 `gh pr diff` 스냅샷으로 물러난다 (이때는 `/fp`도 비활성).

### GitHub에 쓰지 않는다

prfix는 GitHub을 **읽기만** 한다. 로컬 코멘트도, `/fp` 처리 결과도 PR에 코멘트로 올리지 않는다. PR에 드러나는 것은 Push 버튼으로 올린 커밋뿐이다.

Fork에서 올라온 PR은 head 브랜치가 `origin`에 없어 지원하지 않는다.

## CLI 옵션

| 옵션            | 설명                                              |
| --------------- | ------------------------------------------------- |
| `--pr <url>`    | 리뷰할 PR. 범위가 붙은 링크도 그대로 받는다       |
| `--agent <ref>` | 이 세션의 기본 에이전트                           |
| `--dry-run`     | 모든 `/fp` 작업을 스텁으로 실행                   |
| `--no-worktree` | 워크트리 준비를 건너뛴다 (에이전트 수정 비활성화) |
| `--port <port>` | 기본 4966. 사용 중이면 자동으로 다른 포트         |
| `--no-open`     | 브라우저를 자동으로 열지 않는다                   |
| `--keep-alive`  | 탭을 닫아도 서버를 유지한다                       |
| `--background`  | 백그라운드로 띄우고 접속 정보를 JSON으로 출력     |

`--pr` 없이 커밋·브랜치를 인자로 주면 일반 diff 뷰어로도 쓸 수 있다 (`prfix HEAD~3`).

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

| 키                | 기본값               | 뜻                                                  |
| ----------------- | -------------------- | --------------------------------------------------- |
| `defaultAgent`    | `claude@opus5`       | `--agent` 없이 트리거했을 때 쓸 에이전트            |
| `triggerTokens`   | `["/fp", "/fix-pr"]` | 코멘트를 작업으로 인식할 접두사                     |
| `postFixCommands` | `[]`                 | 커밋 직전 워크트리에서 실행할 명령                  |
| `autoMerge`       | `true`               | `false`면 커밋까지만 하고 로컬 머지도 사용자가 직접 |
| `autoPush`        | `false`              | `true`면 작업마다 바로 `origin`에 push              |

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

모델 이름은 alias 테이블에 없으면 그대로 CLI에 넘어간다. 새 모델이 나와도 코드를 고칠 필요 없이 `suggestedModels`에만 추가하면 드롭다운에 뜬다.

기본 매핑:

| ref                  | 실행                                                                             |
| -------------------- | -------------------------------------------------------------------------------- |
| `claude@opus5`       | `claude -p --model opus --permission-mode acceptEdits`                           |
| `claude@sonnet5`     | `claude -p --model sonnet ...`                                                   |
| `claude@haiku45`     | `claude -p --model haiku ...`                                                    |
| `codex@astro6`       | `codex exec -m astro6 -s workspace-write --approve-for-me --skip-git-repo-check` |
| `<provider>@default` | 모델 플래그를 빼고 CLI 자체 기본 모델을 쓴다                                     |

## 문제 해결

| 증상                                                      | 원인·해결                                                                                                             |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `Worktree 준비 실패 — /fp 에이전트 수정이 비활성화됩니다` | 리뷰할 저장소의 클론 밖에서 실행했다. 해당 레포로 `cd` 후 다시 실행                                                   |
| 코멘트를 달아도 작업이 안 생긴다                          | 트리거 없이 Submit했거나, 기존 코멘트를 수정해 트리거를 붙였다. 새 코멘트로 달 것                                     |
| `머지 충돌로 중단했습니다`                                | 앞선 작업과 같은 영역을 고쳤다. `fp/...` 브랜치에 커밋이 남아 있으니 직접 머지                                        |
| `Fork에서 올라온 PR은 아직 지원하지 않습니다`             | head 브랜치가 `origin`에 없어 push할 수 없다                                                                          |
| Push 버튼이 안 보인다                                     | 워크트리가 없어 `/fp`가 비활성이거나, 링크가 head tip이 아닌 범위를 가리킨다                                          |
| 에이전트가 훅 때문에 실패한다                             | 새 워크트리에는 의존성이 없어 로컬 훅이 깨진다. 커밋은 `--no-verify`로 하고, lint·format은 `postFixCommands`로 돌린다 |

## 개발

```bash
pnpm test          # vitest
pnpm check         # oxlint (type-aware)
pnpm format:fix    # oxfmt
pnpm build
```

커밋 시 lefthook이 format → knip → lint → test를 모두 돌린다.

### 구조

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

### HTTP API

| 메서드 | 경로                              | 용도                                                       |
| ------ | --------------------------------- | ---------------------------------------------------------- |
| GET    | `/api/agents`                     | 에이전트 목록·기본값·트리거 토큰                           |
| GET    | `/api/agent-tasks`                | 작업 목록·상태                                             |
| POST   | `/api/agent-tasks`                | `{ threadId, agentRef?, instruction?, noMerge?, dryRun? }` |
| POST   | `/api/agent-tasks/:taskId/cancel` | 취소                                                       |
| GET    | `/api/push-status`                | `origin/<head>` 대비 안 올라간 커밋 수                     |
| POST   | `/api/push`                       | head 브랜치를 push                                         |

작업 진행 상황은 `/api/watch` SSE에 `agentTaskChanged` 이벤트로 흐른다. 나머지 diff·코멘트 API는 difit과 같다.

---

diff 뷰어와 코멘트 UI는 [difit](https://github.com/yoshiko-pg/difit) (MIT)을 기반으로 한다. 업스트림을 따라가려면:

```bash
git fetch upstream && git rebase upstream/main
```
