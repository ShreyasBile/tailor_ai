/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // three.js ships ESM that Next should transpile for the client bundle.
  transpilePackages: ['three'],
  // The web app talks to the API directly from the browser (CORS-enabled),
  // so there is nothing server-side to proxy.
};

export default nextConfig;
