/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["three"],
  // The app is a single client-rendered page with no server code, so it ships
  // as plain static files.
  output: "export",
};
export default nextConfig;
