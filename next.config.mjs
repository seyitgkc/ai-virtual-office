/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["three"],
  // Builds a self-contained Node server in .next/standalone for the container.
  output: "standalone",
};
export default nextConfig;
