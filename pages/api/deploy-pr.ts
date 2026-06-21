import type { NextApiRequest, NextApiResponse } from 'next'
import { buildArtifact, type DeploySpec } from '../../lib/gridmind/manifest'

// Real side effect: opens a pull request on GitHub with the deployment manifest
// for the agent's routing decision. Human-approval-gated (triggered by a button
// after the agent decides), then a human reviews/merges the PR.
export const config = { maxDuration: 20 }

const GH = 'https://api.github.com'
const REPO = process.env.GITHUB_REPO ?? 'saosin06/Gridmind'

async function gh(path: string, token: string, init?: RequestInit) {
  const res = await fetch(`${GH}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'gridmind',
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${json?.message ?? 'request failed'}`)
  return json
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<{ url: string; number: number; branch: string; path: string } | { error: string }>
) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }
  const token = process.env.GITHUB_TOKEN
  if (!token) {
    res.status(400).json({ error: 'GITHUB_TOKEN not configured on the server' })
    return
  }

  const spec = req.body as DeploySpec
  if (!spec?.region || !spec?.workload?.name) {
    res.status(400).json({ error: 'region and workload.name are required' })
    return
  }

  try {
    const artifact = buildArtifact(spec, Date.now())

    // 1. default branch + its head SHA
    const repo = await gh(`/repos/${REPO}`, token)
    const defaultBranch: string = repo.default_branch
    const baseRef = await gh(`/repos/${REPO}/git/ref/heads/${defaultBranch}`, token)
    const baseSha: string = baseRef.object.sha

    // 2. create the branch
    await gh(`/repos/${REPO}/git/refs`, token, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${artifact.branch}`, sha: baseSha }),
    })

    // 3. commit the manifest onto the branch
    await gh(`/repos/${REPO}/contents/${encodeURIComponent(artifact.path)}`, token, {
      method: 'PUT',
      body: JSON.stringify({
        message: artifact.title,
        content: Buffer.from(artifact.yaml).toString('base64'),
        branch: artifact.branch,
      }),
    })

    // 4. open the PR
    const pr = await gh(`/repos/${REPO}/pulls`, token, {
      method: 'POST',
      body: JSON.stringify({ title: artifact.title, head: artifact.branch, base: defaultBranch, body: artifact.body }),
    })

    res.status(200).json({ url: pr.html_url, number: pr.number, branch: artifact.branch, path: artifact.path })
  } catch (err) {
    console.error('[/api/deploy-pr]', err)
    res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to open PR' })
  }
}
