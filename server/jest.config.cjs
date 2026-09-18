module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.(t|j)sx?$': [
      '@swc/jest',
      {
        sourceMaps: 'inline',
        jsc: {
          target: 'es2022',
          parser: {
            syntax: 'typescript'
          }
        },
        module: {
          type: 'commonjs'
        }
      }
    ]
  },
  transformIgnorePatterns: [
    'node_modules/(?!(sanitize-html|htmlparser2|domhandler|domutils|dom-serializer|domelementtype|entities)/)'
  ],
  moduleNameMapper: {
    '^@shared/(.*)$': '<rootDir>/../shared/$1'
  },
  clearMocks: true
};
