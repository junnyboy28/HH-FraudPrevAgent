import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Project guidance lives in the root CLAUDE.md and agent.md, so Next does not
  // generate its own AGENTS.md / CLAUDE.md here.
  agentRules: false,
  // The agent code and the case files live above ui/, so they have to be
  // traced explicitly or a deployment would ship without them.
  outputFileTracingRoot: path.join(import.meta.dirname, '..'),
  outputFileTracingIncludes: {
    '/**': ['../cases/**', '../config/**'],
  },
};

export default nextConfig;
