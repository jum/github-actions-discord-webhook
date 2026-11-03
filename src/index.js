const core = require('@actions/core');
const exec = require('@actions/exec');

// --- status -> embed color / label -------------------------------------------------

const STATUS_MAP = {
  success: { color: 3066993, label: 'Passed' },
  failure: { color: 15158332, label: 'Failed' },
  cancelled: { color: 9807270, label: 'Cancelled' },
};

function statusInfo(status) {
  return STATUS_MAP[String(status).toLowerCase()] || { color: 0, label: 'Status Unknown' };
}

// --- git log helpers -----------------------------------------------------------------
// We shell out to `git log` (same approach as the original send.sh) instead of hitting
// the platform API, so this works identically against a normal checkout on either
// GitHub or Gitea without needing extra permissions.

async function gitLog(format, sha) {
  let output = '';
  await exec.exec('git', ['log', '-1', sha, `--pretty=${format}`], {
    listeners: { stdout: (data) => { output += data.toString(); } },
    silent: true,
  });
  return output.trim();
}

// --- platform detection ---------------------------------------------------------------
// GitHub Actions and Gitea's act_runner both populate GITHUB_SERVER_URL / GITHUB_API_URL,
// GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_REF, etc. so most of this code is platform-agnostic.
// The only real differences are URL shapes (pull vs pulls, tree vs src/branch) and the auth
// header format for API calls, which is what `platform` controls.

function detectPlatform(serverUrl) {
  if (/(^|\.)github\.com$/i.test(new URL(serverUrl).hostname)) {
    return 'github';
  }
  return 'gitea';
}

function urlsForPlatform(platform, serverUrl, repo, branchName, sha, prNum) {
  const repoUrl = `${serverUrl}/${repo}`;
  const commitUrl = `${repoUrl}/commit/${sha}`;

  if (platform === 'gitea') {
    return {
      repoUrl,
      commitUrl,
      branchUrl: `${repoUrl}/src/branch/${branchName}`,
      prUrl: prNum ? `${repoUrl}/pulls/${prNum}` : null,
    };
  }

  // github (and github-compatible) default
  return {
    repoUrl,
    commitUrl,
    branchUrl: `${repoUrl}/tree/${branchName}`,
    prUrl: prNum ? `${repoUrl}/pull/${prNum}` : null,
  };
}

// --- PR title lookup -------------------------------------------------------------------
// Optional: only attempted if a token was supplied, since anonymous API access is often
// rate limited or disabled. Falls back to the merge commit's own subject line otherwise.

async function fetchPullRequestTitle({ platform, apiUrl, repo, prNum, token }) {
  if (!token) return null;

  const url =
    platform === 'gitea'
      ? `${apiUrl.replace(/\/$/, '')}/repos/${repo}/pulls/${prNum}`
      : `${apiUrl.replace(/\/$/, '')}/repos/${repo}/pulls/${prNum}`;

  const headers = {
    Accept: 'application/json',
    Authorization: platform === 'gitea' ? `token ${token}` : `Bearer ${token}`,
    'User-Agent': 'discord-webhook-action',
  };

  try {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      core.warning(`Could not fetch PR title (HTTP ${res.status}); falling back to commit subject.`);
      return null;
    }
    const data = await res.json();
    return data && data.title ? data.title : null;
  } catch (err) {
    core.warning(`Could not fetch PR title (${err.message}); falling back to commit subject.`);
    return null;
  }
}

// --- main --------------------------------------------------------------------------

async function run() {
  const webhookUrls = core
    .getInput('webhook_url', { required: true })
    .split(/\s+/)
    .filter(Boolean);

  const status = core.getInput('status', { required: true });
  const username = core.getInput('username') || undefined;
  const avatarUrl = core.getInput('avatar_url') || 'https://github.com/actions.png';
  const token = core.getInput('token') || undefined;
  const platformInput = core.getInput('platform') || 'auto';

  const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com';
  const apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com';
  const repo = process.env.GITHUB_REPOSITORY || '';
  const sha = process.env.GITHUB_SHA || '';
  const ref = process.env.GITHUB_REF || '';
  const eventName = process.env.GITHUB_EVENT_NAME || '';
  const workflowName = process.env.GITHUB_WORKFLOW || '';
  const runnerOs = process.env.RUNNER_OS || '';

  const platform = platformInput === 'auto' ? detectPlatform(serverUrl) : platformInput;
  core.info(`Detected platform: ${platform} (server: ${serverUrl})`);

  const { color: embedColor, label: statusMessage } = statusInfo(status);

  const authorName = await gitLog('%aN', sha);
  const committerName = await gitLog('%cN', sha);
  let commitSubject = await gitLog('%s', sha);
  let commitMessage = await gitLog('%b', sha);

  const credits =
    authorName === committerName
      ? `${authorName} authored & committed`
      : `${authorName} authored & ${committerName} committed`;

  let branchName = ref.replace(/^refs\/heads\//, '').replace(/^refs\/tags\//, '');
  let branchOrPr = 'Branch';
  let prNum = null;

  if (eventName === 'pull_request' || eventName === 'pull_request_target') {
    branchOrPr = 'Pull Request';
    const prMatch = ref.match(/^refs\/pull\/(\d+)\//);
    prNum = prMatch ? prMatch[1] : null;
    branchName = prNum ? `#${prNum}` : branchName;
  }

  const { repoUrl, commitUrl, branchUrl, prUrl } = urlsForPlatform(
    platform,
    serverUrl,
    repo,
    eventName === 'pull_request' || eventName === 'pull_request_target' ? branchName.replace(/^#/, '') : branchName,
    sha,
    prNum,
  );

  const branchOrPrUrl = prNum ? prUrl : branchUrl;
  const actionUrl = prNum ? `${prUrl}/checks` : `${commitUrl}/checks`;
  const commitOrPrUrl = prNum ? prUrl : commitUrl;

  if (prNum) {
    const prTitle = await fetchPullRequestTitle({ platform, apiUrl, repo, prNum, token });
    if (prTitle) {
      commitSubject = prTitle;
      commitMessage = `Pull Request #${prNum}`;
    }
  }

  const embed = {
    color: embedColor,
    author: {
      name: `${statusMessage}: ${workflowName} (${runnerOs}) - ${repo}`,
      url: actionUrl,
      icon_url: avatarUrl,
    },
    title: commitSubject,
    url: commitOrPrUrl,
    description: commitMessage ? `${commitMessage}\n\n${credits}` : credits,
    fields: [
      {
        name: 'Commit',
        value: `[\`${sha.substring(0, 7)}\`](${commitUrl})`,
        inline: true,
      },
      {
        name: branchOrPr,
        value: `[\`${branchName}\`](${branchOrPrUrl})`,
        inline: true,
      },
    ],
    timestamp: new Date().toISOString(),
  };

  const payload = {
    avatar_url: avatarUrl,
    embeds: [embed],
  };
  if (username) payload.username = username;

  let anyFailed = false;
  for (const webhookUrl of webhookUrls) {
    core.info('Sending webhook to Discord...');
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'discord-webhook-action',
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        anyFailed = true;
        const body = await res.text().catch(() => '');
        core.error(`Discord webhook responded with HTTP ${res.status}: ${body}`);
      } else {
        core.info('Successfully sent the webhook.');
      }
    } catch (err) {
      anyFailed = true;
      core.error(`Unable to send webhook: ${err.message}`);
    }
  }

  if (anyFailed) {
    core.setFailed('One or more Discord webhook deliveries failed.');
  }
}

run().catch((err) => core.setFailed(err.message));
