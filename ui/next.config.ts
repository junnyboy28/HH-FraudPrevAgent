import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Project guidance lives in the root CLAUDE.md and agent.md, so Next does not
  // generate its own AGENTS.md / CLAUDE.md here.
  agentRules: false,
};

export default nextConfig;
