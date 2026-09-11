#!/usr/bin/env node

import { Command } from 'commander';
import { simpleGit, type SimpleGit } from 'simple-git';

import pkg from '../../package.json' with { type: 'json' };
import { startServer } from '../server/server.js';
import { type CommentImport, type DiffSelection } from '../types/diff.js';
import { type PrContext } from '../types/agent.js';
import { createDiffSelection } from '../utils/diffSelection.js';
import { DiffMode } from '../types/watch.js';

import {
  shouldReadStdin,
  findUntrackedFiles,
  markFilesIntentToAdd,
  promptUser,
  parseCommentOptions,
  validateDiffArguments,
  getGitRoot,
  readStdin,
} from './utils.js';
import { createCommentCommand } from './comment.js';
import {
  getPrPatch,
  getPrCommentImports,
  getPrMeta,
  normalizePrUrl,
  type PrMeta,
} from './github.js';
import { parsePrRange } from './pr-range.js';
import { ensureRevisionsAvailable, preparePrWorktree, syncWorktreeWithRemote } from './worktree.js';
import {
  BACKGROUND_CHILD_ENV,
  emitBackgroundHandshake,
  ignoreStdioErrorsForBackgroundDaemon,
  startBackgroundProcess,
} from './background.js';

type SpecialArg = 'working' | 'staged' | '.';

function isSpecialArg(arg: string): arg is SpecialArg {
  return arg === 'working' || arg === 'staged' || arg === '.';
}

function resolveDiffSelection(
  commitish: string,
  compareWith?: string,
  mergeBase?: boolean,
): DiffSelection {
  let baseCommitish: string;

  if (compareWith) {
    baseCommitish = compareWith;
  } else if (commitish === 'working') {
    baseCommitish = 'staged';
  } else if (isSpecialArg(commitish)) {
    baseCommitish = 'HEAD';
  } else {
    baseCommitish = commitish + '^';
  }

  return createDiffSelection(baseCommitish, commitish, mergeBase ? 'merge-base' : undefined);
}

function determineDiffMode(selection: DiffSelection, compareWith?: string): DiffMode {
  const { targetCommitish } = selection;

  // If comparing specific commits/branches (not involving HEAD), no watching needed
  // Exception: allow watching when targetCommitish is '.' even with compareWith
  if (compareWith && targetCommitish !== 'HEAD' && targetCommitish !== '.') {
    return DiffMode.SPECIFIC;
  }

  if (targetCommitish === 'working') {
    return DiffMode.WORKING;
  }

  if (targetCommitish === 'staged') {
    return DiffMode.STAGED;
  }

  if (targetCommitish === '.') {
    return DiffMode.DOT;
  }
  // Default mode: HEAD^ vs HEAD or HEAD vs other commits (watch for HEAD changes)
  return DiffMode.DEFAULT;
}

interface CliOptions {
  port?: number;
  host?: string;
  open: boolean;
  comment: string[];
  pr?: string;
  clean?: boolean;
  includeUntracked?: boolean;
  keepAlive?: boolean;
  background?: boolean;
  context?: number;
  mergeBase?: boolean;
  worktree: boolean;
  agent?: string;
  dryRun?: boolean;
}

const program = new Command();

program
  .name('prfix')
  .description(
    'Review a GitHub PR locally and hand review comments to a coding agent (/fp) that fixes, commits, and merges them back',
  )
  .version(pkg.version, '-v, --version', 'output the version number')
  .enablePositionalOptions()
  .addCommand(createCommentCommand())
  .argument(
    '[commit-ish]',
    'Git commit, tag, branch, HEAD~n reference, or "working"/"staged"/"."',
    'HEAD',
  )
  .argument(
    '[compare-with]',
    'Optional: Compare with this commit/branch (shows diff between commit-ish and compare-with)',
  )
  .option('--port <port>', 'preferred port (auto-assigned if occupied)', parseInt)
  .option('--host <host>', 'host address to bind', '')
  .option('--no-open', 'do not automatically open browser')
  .option(
    '--comment <json>',
    'inject initial review comments (repeatable, accepts a JSON object or array)',
    (value: string, previous: string[]) => [...previous, value],
    [],
  )
  .option('--pr <url>', 'GitHub PR URL to review (e.g., https://github.com/owner/repo/pull/123)')
  .option('--clean', 'start with a clean slate by clearing all existing comments')
  .option('--include-untracked', 'automatically include untracked files in diff')
  .option('--keep-alive', 'keep server running even after browser disconnects')
  .option('--background', 'keep the server running in the background and output JSON info')
  .option('--context <lines>', 'number of context lines shown around each change', parseInt)
  .option(
    '--merge-base',
    'resolve the base revision with git merge-base before diffing (Git revision mode only)',
  )
  .option(
    '--no-worktree',
    'skip preparing a worktree for the PR head branch (disables /fp agent fixes)',
  )
  .option('--agent <ref>', 'default agent for /fp comments (e.g. claude@opus5, codex@astro6)')
  .option('--dry-run', 'run /fp tasks with a stub instead of a real agent')
  .action(async (commitish: string, compareWith: string | undefined, options: CliOptions) => {
    try {
      const isBackgroundChild = process.env[BACKGROUND_CHILD_ENV] === '1';
      const backgroundMode = options.background || isBackgroundChild;
      let stdinDiff: string | undefined;
      let stdinReviewLabel = 'diff from stdin';
      let manualCommentImports: CommentImport[] = [];
      let commentImports: CommentImport[] = [];
      let prContext: PrContext | undefined;
      let prSelection: DiffSelection | undefined;
      let prIsHeadTip = true;

      if (
        options.context !== undefined &&
        (!Number.isInteger(options.context) || options.context < 0)
      ) {
        console.error('Error: --context must be a non-negative integer');
        process.exit(1);
      }

      if (options.background && !isBackgroundChild) {
        await startBackgroundProcess();
        return;
      }

      try {
        manualCommentImports = parseCommentOptions(options.comment);
        commentImports = manualCommentImports;
      } catch (error) {
        console.error(
          `Error: ${error instanceof Error ? error.message : 'Invalid --comment value'}`,
        );
        process.exit(1);
      }

      if (backgroundMode) {
        options.keepAlive = true;
        options.open = false;
      }

      if (options.pr) {
        if (commitish !== 'HEAD' || compareWith) {
          console.error('Error: --pr option cannot be used with positional arguments');
          process.exit(1);
        }

        if (options.mergeBase) {
          console.error('Error: --merge-base option cannot be used with --pr');
          process.exit(1);
        }

        if (options.context !== undefined) {
          console.error('Error: --context option cannot be used with --pr');
          process.exit(1);
        }

        // 링크에 범위가 붙어 있을 수 있다. gh에는 PR 자체를 가리키는 URL만 넘긴다.
        const prUrl = normalizePrUrl(options.pr);
        if (!prUrl) {
          console.error(`Error: GitHub PR URL이 아닙니다: ${options.pr}`);
          process.exit(1);
        }

        let prMeta: PrMeta | undefined;
        try {
          prMeta = getPrMeta(prUrl);
        } catch (error) {
          console.error(
            `Error resolving PR: ${error instanceof Error ? error.message : 'Unknown error'}`,
          );
          process.exit(1);
        }

        // /fp 작업은 head 브랜치가 체크아웃된 워크트리에서 실행된다. 준비에 실패해도
        // diff 리뷰 자체는 가능하므로 경고만 남기고 계속 진행한다.
        if (options.worktree) {
          try {
            prContext = preparePrWorktree(prUrl, prMeta);
            syncWorktreeWithRemote(prContext);
            console.log(`📂 Worktree: ${prContext.repoPath} (${prContext.headBranch})`);
          } catch (error) {
            console.warn(
              `Warning: Worktree 준비 실패 — /fp 에이전트 수정이 비활성화됩니다: ${
                error instanceof Error ? error.message : 'Unknown error'
              }`,
            );
          }
        }

        // 워크트리가 있으면 diff를 로컬 git에서 뽑는다. gh pr diff 스냅샷과 달리
        // 에이전트가 만든 커밋이 바로 반영되고, 파일 워처가 Refresh 버튼을 띄운다.
        if (prContext) {
          const range = parsePrRange(options.pr);
          const unresolved = range
            ? ensureRevisionsAvailable(
                prContext,
                prMeta.number,
                [range.base, range.target].filter((value): value is string => Boolean(value)),
              )
            : [];

          if (unresolved.length > 0) {
            console.error(
              `Error: 링크의 리비전을 로컬에서 찾지 못했습니다: ${unresolved.join(', ')}`,
            );
            process.exit(1);
          }

          prSelection = createDiffSelection(
            range?.base ?? `${prContext.remote}/${prMeta.baseRefName}`,
            range?.target ?? 'HEAD',
            range?.base ? undefined : 'merge-base',
          );

          // 링크가 head tip이 아닌 커밋을 가리키면 화면의 라인 번호가 head와 어긋난다.
          // 엉뚱한 줄을 고칠 수 있으므로 그 경우 에이전트 수정을 막는다.
          prIsHeadTip = !range?.target;
          stdinReviewLabel = `${options.pr} (local ${prContext.headBranch}${
            range ? `, ${range.label}` : ''
          })`;
        } else {
          try {
            stdinDiff = getPrPatch(prUrl);
            stdinReviewLabel = prUrl;
          } catch (error) {
            console.error(
              `Error resolving PR: ${error instanceof Error ? error.message : 'Unknown error'}`,
            );
            process.exit(1);
          }
        }

        try {
          const prCommentImports = await getPrCommentImports(prUrl);
          commentImports = [...prCommentImports, ...manualCommentImports];
        } catch (error) {
          console.warn(
            `Warning: Failed to load PR review comments: ${error instanceof Error ? error.message : 'Unknown error'}`,
          );
        }
      } else {
        // Check if we should read from stdin
        const readFromStdin = shouldReadStdin({
          commitish,
          hasPositionalArgs: program.args.length > 0,
          hasPrOption: false,
        });

        if (readFromStdin) {
          if (options.context !== undefined) {
            console.error('Error: --context option cannot be used with stdin diff');
            process.exit(1);
          }
          if (options.mergeBase) {
            console.error('Error: --merge-base option cannot be used with stdin diff');
            process.exit(1);
          }
          // Read unified diff from stdin
          stdinDiff = await readStdin();
          if (!stdinDiff.trim()) {
            console.error('Error: No diff content received from stdin');
            process.exit(1);
          }
        }
      }

      if (prSelection && prContext) {
        // PR 모드지만 diff는 리뷰 워크트리의 로컬 git에서 뽑는다.
        if (!prIsHeadTip) {
          console.warn(
            'Warning: 링크가 head tip이 아닌 범위를 가리켜 /fp 에이전트 수정을 비활성화합니다.',
          );
        }

        const { url, port } = await startServer({
          selection: prSelection,
          repoPath: prContext.repoPath,
          diffMode: prIsHeadTip ? DiffMode.DEFAULT : DiffMode.SPECIFIC,
          ...(prIsHeadTip ? { prContext } : {}),
          preferredPort: options.port,
          host: options.host,
          openBrowser: options.open,
          clearComments: options.clean,
          keepAlive: options.keepAlive,
          ...(options.agent ? { defaultAgentRef: options.agent } : {}),
          ...(options.dryRun ? { dryRun: true } : {}),
          ...(commentImports.length > 0 ? { commentImports } : {}),
        });

        if (backgroundMode) {
          emitBackgroundHandshake({ port, url, pid: process.pid });
          if (isBackgroundChild) {
            ignoreStdioErrorsForBackgroundDaemon();
          }
          return;
        }

        console.log(`\n🚀 prfix server started on ${url}`);
        console.log(`📋 Reviewing: ${stdinReviewLabel}`);
        if (options.keepAlive) {
          console.log('🔒 Keep-alive mode: server will stay running after browser disconnects');
        }
        console.log('\nPress Ctrl+C to stop the server');
        return;
      }

      if (stdinDiff) {
        // Start server with stdin diff (including --pr patch fallback)
        const { url, port } = await startServer({
          stdinDiff,
          preferredPort: options.port,
          host: options.host,
          openBrowser: options.open,
          clearComments: options.clean,
          keepAlive: options.keepAlive,
          ...(prContext ? { prContext, repoPath: prContext.repoPath } : {}),
          ...(options.agent ? { defaultAgentRef: options.agent } : {}),
          ...(options.dryRun ? { dryRun: true } : {}),
          ...(commentImports.length > 0 ? { commentImports } : {}),
        });

        if (backgroundMode) {
          emitBackgroundHandshake({ port, url, pid: process.pid });
          if (isBackgroundChild) {
            ignoreStdioErrorsForBackgroundDaemon();
          }
          return;
        }

        console.log(`\n🚀 prfix server started on ${url}`);
        console.log(`📋 Reviewing: ${stdinReviewLabel}`);
        if (options.keepAlive) {
          console.log('🔒 Keep-alive mode: server will stay running after browser disconnects');
        }
        console.log('\nPress Ctrl+C to stop the server');
        return;
      }

      // Detect git root
      let repoPath: string | undefined;
      try {
        repoPath = getGitRoot();
      } catch {
        // If not in a git repository, fall back to process.cwd()
        repoPath = undefined;
      }

      const selection = resolveDiffSelection(commitish, compareWith, options.mergeBase);

      if (options.mergeBase && isSpecialArg(selection.baseCommitish)) {
        console.error(
          `Error: --merge-base requires a commit-ish base, but resolved base was "${selection.baseCommitish}"`,
        );
        process.exit(1);
      }

      if (selection.targetCommitish === 'working' || selection.targetCommitish === '.') {
        const git = simpleGit(repoPath);
        if (isBackgroundChild && !options.includeUntracked) {
          // Skip interactive prompts in detached background mode.
        } else {
          await handleUntrackedFiles(git, options.includeUntracked);
        }
      }

      const validation = validateDiffArguments(selection.targetCommitish, compareWith);
      if (!validation.valid) {
        console.error(`Error: ${validation.error}`);
        process.exit(1);
      }

      const { url, port, isEmpty } = await startServer({
        selection,
        preferredPort: options.port,
        host: options.host,
        openBrowser: options.open,
        clearComments: options.clean,
        keepAlive: options.keepAlive,
        contextLines: options.context,
        diffMode: determineDiffMode(selection, compareWith),
        repoPath,
        ...(commentImports.length > 0 ? { commentImports } : {}),
      });

      if (backgroundMode) {
        emitBackgroundHandshake({ port, url, pid: process.pid });
        if (isBackgroundChild) {
          ignoreStdioErrorsForBackgroundDaemon();
        }
        return;
      }

      console.log(`\n🚀 prfix server started on ${url}`);
      console.log(`📋 Reviewing: ${selection.targetCommitish}`);

      if (options.keepAlive) {
        console.log('🔒 Keep-alive mode: server will stay running after browser disconnects');
      }

      if (options.clean) {
        console.log('🧹 Starting with a clean slate - all existing comments will be cleared');
      }

      if (isEmpty) {
        console.log(
          '\n! \x1b[33mNo differences found. Browser will not open automatically.\x1b[0m',
        );
        console.log(`   Server is running at ${url} if you want to check manually.\n`);
      } else if (options.open) {
        console.log('🌐 Opening browser...\n');
      } else {
        console.log('💡 Use --open to automatically open browser\n');
      }

      process.on('SIGINT', async () => {
        console.log('\n👋 Shutting down prfix server...');

        // Try to fetch comments before shutting down
        try {
          const response = await fetch(`http://localhost:${port}/api/comments-output`);
          if (response.ok) {
            const data = await response.text();
            if (data.trim()) {
              console.log(data);
            }
          }
        } catch {
          // Silently ignore fetch errors during shutdown
        }

        process.exit(0);
      });
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : 'Unknown error');
      process.exit(1);
    }
  });

void program.parseAsync();

async function handleUntrackedFiles(git: SimpleGit, addAutomatically?: boolean): Promise<void> {
  const files = await findUntrackedFiles(git);
  if (files.length === 0) {
    return;
  }

  const shouldAdd = addAutomatically || (await promptUserToIncludeUntracked(files));

  if (shouldAdd) {
    await markFilesIntentToAdd(git, files);
    console.log('✅ Files added with --intent-to-add');
    const filesAsArgs = files.join(' ');
    console.log(`   💡 To undo this, run \`git reset -- ${filesAsArgs}\``);
  } else {
    console.log('i Untracked files will not be shown in diff');
  }
}

async function promptUserToIncludeUntracked(files: string[]): Promise<boolean> {
  console.log(`\n📝 Found ${files.length} untracked file(s):`);
  for (const file of files) {
    console.log(`    - ${file}`);
  }

  return await promptUser(
    '\n❓ Would you like to include these untracked files in the diff review? (Y/n): ',
  );
}
