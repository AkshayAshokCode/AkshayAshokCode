// Generates assets/github-stats-{dark,light}.svg from the GitHub GraphQL API.
// The README picks one via <picture>, matching the viewer's GitHub theme.
// Run locally:  GH_TOKEN=$(gh auth token) node .github/scripts/generate-stats.mjs
// The token must belong to the profile owner so private contributions are counted.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const USER = "AkshayAshokCode";
const OUT_DIR = process.env.OUT_DIR || "assets";
const TOKEN = process.env.GH_TOKEN;

const THEMES = {
  dark: {
    bg: "#0d1117",
    border: "#38d252",
    title: "#2fbf71",
    text: "#fefefe",
    icon: "#1f6fea",
    iconGlow: "#79c0ff",
    ring: "#2fbf71",
  },
  light: {
    bg: "#ffffff",
    border: "#2da44e",
    title: "#1a7f37",
    text: "#1f2328",
    icon: "#0969da",
    iconGlow: "#54aeff",
    ring: "#1a7f37",
  },
};

if (!TOKEN) {
  console.error("GH_TOKEN is not set");
  process.exit(1);
}

async function gql(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(json.errors ?? json)}`);
  }
  return json.data;
}

// ---------- Fetch ----------

const base = await gql(
  `query($login: String!) {
    user(login: $login) {
      name
      createdAt
      followers { totalCount }
      pullRequests { totalCount }
      issues { totalCount }
    }
  }`,
  { login: USER },
);
const user = base.user;

// Stars: non-fork repos owned by me, or by an organization I administer.
async function fetchStars() {
  let stars = 0;
  let cursor = null;
  do {
    const data = await gql(
      `query($login: String!, $cursor: String) {
        user(login: $login) {
          repositories(first: 100, after: $cursor, isFork: false,
                       ownerAffiliations: [OWNER, ORGANIZATION_MEMBER]) {
            pageInfo { hasNextPage endCursor }
            nodes {
              stargazerCount
              owner { login ... on Organization { viewerCanAdminister } }
            }
          }
        }
      }`,
      { login: USER, cursor },
    );
    const page = data.user.repositories;
    for (const repo of page.nodes) {
      const mine = repo.owner.login === USER || repo.owner.viewerCanAdminister === true;
      if (mine) stars += repo.stargazerCount;
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return stars;
}

// All-time commits and reviews. contributionsCollection spans at most one year,
// so query each year since the account was created (aliased, in one request).
async function fetchContributions() {
  const startYear = new Date(user.createdAt).getUTCFullYear();
  const now = new Date();
  const ranges = [];
  for (let y = startYear; y <= now.getUTCFullYear(); y++) {
    const from = new Date(Date.UTC(y, 0, 1));
    const to = y === now.getUTCFullYear() ? now : new Date(Date.UTC(y, 11, 31, 23, 59, 59));
    ranges.push([y, from.toISOString(), to.toISOString()]);
  }
  const fields = ranges
    .map(
      ([y, from, to]) => `y${y}: contributionsCollection(from: "${from}", to: "${to}") {
        totalCommitContributions
        restrictedContributionsCount
        totalPullRequestReviewContributions
      }`,
    )
    .join("\n");
  const data = await gql(`query($login: String!) { user(login: $login) { ${fields} } }`, {
    login: USER,
  });
  let commits = 0;
  let reviews = 0;
  for (const c of Object.values(data.user)) {
    // restrictedContributionsCount covers private work the token can't see
    // (only non-zero when "Include private contributions" is on in profile settings).
    commits += c.totalCommitContributions + c.restrictedContributionsCount;
    reviews += c.totalPullRequestReviewContributions;
  }
  return { commits, reviews };
}

const [stars, { commits, reviews }] = await Promise.all([fetchStars(), fetchContributions()]);
const prs = user.pullRequests.totalCount;
const issues = user.issues.totalCount;
const followers = user.followers.totalCount;

// ---------- Rank (same formula as github-readme-stats, all-commits mode) ----------

const expCdf = (x) => 1 - 2 ** -x;
const logCdf = (x) => x / (1 + x);

const WEIGHTS = { commits: 2, prs: 3, issues: 1, reviews: 1, stars: 4, followers: 1 };
const totalWeight = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);

const score =
  WEIGHTS.commits * expCdf(commits / 1000) +
  WEIGHTS.prs * expCdf(prs / 50) +
  WEIGHTS.issues * expCdf(issues / 25) +
  WEIGHTS.reviews * expCdf(reviews / 2) +
  WEIGHTS.stars * logCdf(stars / 50) +
  WEIGHTS.followers * logCdf(followers / 10);

const percentile = (1 - score / totalWeight) * 100;
const LEVELS = ["S", "A+", "A", "A-", "B+", "B", "B-", "C+", "C"];
const CUTOFFS = [1, 12.5, 25, 37.5, 50, 62.5, 75, 87.5, 100];
const grade = LEVELS[CUTOFFS.findIndex((t) => percentile <= t)];

// ---------- Render ----------

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch]);

const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n));

// GitHub Octicons (MIT)
const ICONS = {
  star: "M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25zm0 2.445L6.615 5.5a.75.75 0 01-.564.41l-3.097.45 2.24 2.184a.75.75 0 01.216.664l-.528 3.084 2.769-1.456a.75.75 0 01.698 0l2.77 1.456-.53-3.084a.75.75 0 01.216-.664l2.24-2.183-3.096-.45a.75.75 0 01-.564-.41L8 2.694v.001z",
  commit: "M1.643 3.143L.427 1.927A.25.25 0 000 2.104V5.75c0 .138.112.25.25.25h3.646a.25.25 0 00.177-.427L2.715 4.215a6.5 6.5 0 11-1.18 4.458.75.75 0 10-1.493.154 8.001 8.001 0 101.6-5.684zM7.75 4a.75.75 0 01.75.75v2.992l2.028.812a.75.75 0 01-.557 1.392l-2.5-1A.75.75 0 017 8.25v-3.5A.75.75 0 017.75 4z",
  pr: "M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z",
  review: "M1.679 7.932c.412-.621 1.242-1.75 2.366-2.717C5.175 4.242 6.527 3.5 8 3.5c1.473 0 2.824.742 3.955 1.715 1.124.967 1.954 2.096 2.366 2.717a.119.119 0 010 .136c-.412.621-1.242 1.75-2.366 2.717C10.825 11.758 9.473 12.5 8 12.5c-1.473 0-2.824-.742-3.955-1.715C2.92 9.818 2.09 8.69 1.679 8.068a.119.119 0 010-.136zM8 2c-1.981 0-3.67.992-4.933 2.078C1.797 5.169.88 6.423.43 7.1a1.619 1.619 0 000 1.798c.45.678 1.367 1.932 2.637 3.024C4.329 13.008 6.019 14 8 14c1.981 0 3.67-.992 4.933-2.078 1.27-1.091 2.187-2.345 2.637-3.023a1.619 1.619 0 000-1.798c-.45-.678-1.367-1.932-2.637-3.023C11.671 2.992 9.981 2 8 2zm0 8a2 2 0 100-4 2 2 0 000 4z",
  issue: "M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM0 8a8 8 0 1116 0A8 8 0 010 8zm9 3a1 1 0 11-2 0 1 1 0 012 0zm-.25-6.25a.75.75 0 00-1.5 0v3.5a.75.75 0 001.5 0v-3.5z",
};

const rows = [
  ["star", "Total Stars Earned:", stars],
  ["commit", "Total Commits:", commits],
  ["pr", "Total PRs:", prs],
  ["issue", "Total Issues:", issues],
];
// Show the reviews row only once there's something to show (it always counts toward the rank).
if (reviews > 0) rows.splice(3, 0, ["review", "Total PRs Reviewed:", reviews]);

const ROW_H = 25;
const BODY_Y = 55;
const WIDTH = 467;
const HEIGHT = BODY_Y + rows.length * ROW_H + 20;
const R = 40;
const C = 2 * Math.PI * R;
const ringCx = 380;
const ringCy = BODY_Y + ((rows.length - 1) * ROW_H) / 2 + 6;
const title = `${user.name || USER}'s GitHub Stats`;

// Count-up: SVG text can't be changed by CSS, so we stack one <text> per frame
// and show each one only for its slice of time. The last frame stays visible.
const COUNT_FRAMES = 24;
const COUNT_MS = 1200;
const easeOut = (t) => 1 - (1 - t) ** 3;

function countUp(value, startMs, x, y) {
  const frames = [];
  for (let i = 1; i <= COUNT_FRAMES; i++) {
    const label = fmt(Math.round(value * easeOut(i / COUNT_FRAMES)));
    const at = startMs + (i - 1) * (COUNT_MS / COUNT_FRAMES);
    if (frames.length && frames.at(-1).label === label) continue;
    frames.push({ label, at });
  }
  return frames
    .map(({ label, at }, i) => {
      const last = i === frames.length - 1;
      const dur = last ? 1 : frames[i + 1].at - at;
      const cls = last ? "num last" : "num";
      return `<text class="stat ${cls}" x="${x}" y="${y}" style="animation:show ${dur.toFixed(0)}ms linear ${at.toFixed(0)}ms${last ? " forwards" : ""}">${esc(label)}</text>`;
    })
    .join("");
}

const rowSvg = rows
  .map(([icon, label, value], i) => {
    const delay = 450 + i * 150;
    return `
    <g class="stagger" style="animation-delay:${delay}ms" transform="translate(25, ${BODY_Y + i * ROW_H})">
      <g class="pop" style="animation-delay:${delay}ms"><svg class="icon" viewBox="0 0 16 16" width="16" height="16" overflow="visible"><path fill-rule="evenodd" d="${ICONS[icon]}"/></svg></g>
      <text class="stat" x="25" y="12.5">${esc(label)}</text>
      ${countUp(value, delay + 150, 219, 12.5)}
    </g>`;
  })
  .join("");

const render = (THEME) => `<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="titleId descId">
  <title id="titleId">${esc(title)}, Rank: ${grade}</title>
  <desc id="descId">Stars: ${stars}, Commits: ${commits}, PRs: ${prs}, Reviews: ${reviews}, Issues: ${issues}</desc>
  <style>
    .header { font: 600 18px 'Segoe UI', Ubuntu, Sans-Serif; fill: ${THEME.title}; animation: fadeIn 0.8s ease-in-out forwards; }
    .stat { font: 600 14px 'Segoe UI', Ubuntu, 'Helvetica Neue', Sans-Serif; fill: ${THEME.text}; }
    .stagger { opacity: 0; animation: fadeIn 0.3s ease-in-out forwards; }
    .icon { fill: ${THEME.icon}; }
    .rank-text { font: 800 24px 'Segoe UI', Ubuntu, Sans-Serif; fill: ${THEME.text}; }
    .rim { stroke: ${THEME.ring}; fill: none; stroke-width: 6; opacity: 0.2; }
    .ring { stroke: ${THEME.ring}; fill: none; stroke-width: 6; stroke-linecap: round; opacity: 0.8;
            stroke-dasharray: ${C.toFixed(2)}; stroke-dashoffset: ${((C * percentile) / 100).toFixed(2)};
            animation: ring 1.4s 0.4s cubic-bezier(.4,0,.2,1) backwards; }
    .grade { transform-box: fill-box; transform-origin: center; animation: popIn 0.5s 1.6s cubic-bezier(.3,1.6,.5,1) backwards; }
    .pop { transform-box: fill-box; transform-origin: center; animation: popIn 0.4s cubic-bezier(.3,1.6,.5,1) backwards; }
    .num { opacity: 0; }
    /* Icon wave: icons light up one after another, looping while the card is on screen. */
    .icon { overflow: visible; }
    .icon path { transform-box: fill-box; transform-origin: center; animation: wave 5s ease-in-out infinite; }
    ${rows.map((_, i) => `.stagger:nth-of-type(${i + 1}) .icon path { animation-delay: ${2.5 + i * 0.25}s; }`).join("\n    ")}
    @keyframes ring { from { stroke-dashoffset: ${C.toFixed(2)}; } }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    @keyframes show { from, to { opacity: 1; } }
    @keyframes popIn { from { transform: scale(0); } }
    @keyframes wave { 0%, 12%, 100% { transform: scale(1); fill: ${THEME.icon}; } 6% { transform: scale(1.25); fill: ${THEME.iconGlow}; } }
    @media (prefers-reduced-motion: reduce) {
      * { animation: none !important; }
      .stagger, .num.last { opacity: 1; }
    }
  </style>
  <rect x="0.5" y="0.5" rx="4.5" width="${WIDTH - 1}" height="${HEIGHT - 1}" fill="${THEME.bg}" stroke="${THEME.border}"/>
  <text x="25" y="35" class="header">${esc(title)}</text>
  ${rowSvg}
  <g transform="translate(${ringCx}, ${ringCy})">
    <circle class="rim" r="${R}"/>
    <circle class="ring" r="${R}" transform="rotate(-90)"/>
    <text class="rank-text grade" text-anchor="middle" dominant-baseline="central">${grade}</text>
  </g>
</svg>
`;

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, theme] of Object.entries(THEMES)) {
  writeFileSync(join(OUT_DIR, `github-stats-${name}.svg`), render(theme));
}
console.log(
  `Wrote ${OUT_DIR}/github-stats-{${Object.keys(THEMES).join(",")}}.svg: stars=${stars} commits=${commits} prs=${prs} reviews=${reviews} issues=${issues} followers=${followers} -> ${grade} (top ${percentile.toFixed(1)}%)`,
);
