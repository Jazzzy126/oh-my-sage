/** @type {import('next').NextConfig} */
const nextConfig = {
  // 独立运行输出，便于直接部署到轻量化设备或容器
  output: 'standalone',

  // 实验性功能
  experimental: {
    serverComponentsExternalPackages: ['ws', 'elliptic', 'bn.js'],
    // 排除无关目录，避免 standalone 追踪并复制 .git / 测试 / 构建产物
    outputFileTracingExcludes: {
      '*': [
        '.git/**',
        '**/.git/**',
        '.sessionstore/**',
        'rules/**',
        'coverage/**',
      ],
    },
    // 启用服务器操作
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },

  // Webpack 配置
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // 客户端不包含这些模块
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
        ws: false,
      };
    }
    return config;
  },
};

module.exports = nextConfig;
