/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['mammoth', 'firebase-admin', 'docx', 'pdf-parse', 'pdf-lib'],
};

export default nextConfig;
