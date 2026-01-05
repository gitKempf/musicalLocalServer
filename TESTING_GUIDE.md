# Testing Guide - Musical.run Local Server

Quick reference for running tests and understanding test structure.

## Quick Start

```bash
# Install dependencies
npm install

# Build project
npm run build

# Run all tests
npm test

# Run with coverage
npm run test:coverage
```

## Test Commands

| Command | Description | When to Use |
|---------|-------------|-------------|
| `npm test` | Run all tests | Before commits |
| `npm run test:unit` | Unit tests only | Testing individual components |
| `npm run test:integration` | Integration tests only | Testing API endpoints |
| `npm run test:e2e` | E2E tests only | Testing full flow (manual) |
| `npm run test:watch` | Watch mode | During development |
| `npm run test:coverage` | Generate coverage | Before releases |
| `npm run test:ci` | CI mode | In GitHub Actions |
| `./run-tests.sh` | Full suite + coverage | Complete testing |

## Test Structure

```
__tests__/
├── setup.ts                           # Global test setup
├── cli/                               # CLI tests (bash)
│   └── musical-cli.test.sh            # Musical CLI test suite
├── unit/                              # Unit tests (20 tests)
│   └── EncryptionService.test.ts
├── integration/                       # Integration tests (49 tests)
│   ├── api.test.ts
│   └── claude-agent.test.ts           # Phase 1.2 (stubs)
└── e2e/                               # E2E tests
    └── encrypted-communication.test.ts
```

## CLI Tests

The `musical` CLI has its own bash test suite:

```bash
# Run all CLI tests
./__tests__/cli/musical-cli.test.sh

# Run unit tests only (no Docker required)
./__tests__/cli/musical-cli.test.sh --unit

# Run integration tests only (requires Docker)
./__tests__/cli/musical-cli.test.sh --integration
```

### CLI Test Coverage

- **Unit Tests**: Command parsing, help text, argument validation
- **Integration Tests**: Docker interaction, instance status, verify command
- **Environment Variable Tests**: Install directory resolution

## What Each Test Suite Tests

### Unit Tests (20 tests)
- **EncryptionService**: libsodium encryption, keypair generation, key rotation
- Tests run in <3 seconds
- 100% coverage of EncryptionService

### Integration Tests (49 tests)
- **API Routes**: Sessions, Projects, Status endpoints
- **Error Handling**: 404s, malformed JSON, validation
- **Performance**: Concurrent requests, response times
- Tests run in <5 seconds
- 82% coverage of routes

### E2E Tests (manual verification)
- **WebSocket**: Real-time encrypted communication
- **Privacy**: Zero-knowledge verification
- **Streaming**: Progress updates
- Require manual running due to async cleanup

## Current Test Status

✅ **69 automated tests passing** (20 unit + 49 integration)
✅ **78.5% code coverage**
✅ **All performance benchmarks exceeded**

## Adding New Tests

### Unit Test Template

```typescript
// __tests__/unit/MyService.test.ts
describe('MyService', () => {
  let service: MyService;

  beforeEach(() => {
    service = new MyService();
  });

  test('should do something', () => {
    expect(service.doSomething()).toBe(expected);
  });
});
```

### Integration Test Template

```typescript
// __tests__/integration/my-endpoint.test.ts
import request from 'supertest';
import express from 'express';

describe('My Endpoint', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    // Setup routes
  });

  test('should return 200', async () => {
    await request(app)
      .get('/api/endpoint')
      .expect(200);
  });
});
```

## Coverage Reports

After running `npm run test:coverage`, open:
```
file://$(pwd)/coverage/index.html
```

Coverage goals:
- Statements: 80%+ (current: 78.5%)
- Branches: 75%+ (current: 65.2%)
- Functions: 80%+ (current: 82.1%)
- Lines: 80%+ (current: 79.3%)

## CI/CD

Tests run automatically on:
- Push to `main` or `develop`
- Pull requests
- Node.js versions: 18.x, 20.x

See `.github/workflows/test.yml` for configuration.

## Troubleshooting

### Tests timeout
**Solution**: Increase timeout in jest.config.js or individual test

### Coverage not generated
**Solution**: Run `npm run test:coverage` explicitly

### E2E tests hang
**Solution**: Run manually or check WebSocket server cleanup

### Import errors
**Solution**: Run `npm run build` first

## Best Practices

1. ✅ **Write tests first** (TDD)
2. ✅ **One assertion per test** (when possible)
3. ✅ **Clear test names** (describe what's being tested)
4. ✅ **Clean up after tests** (use afterEach/afterAll)
5. ✅ **Mock external dependencies** (no real API calls)
6. ✅ **Test error cases** (not just happy paths)

## Performance Targets

| Metric | Target | Actual |
|--------|--------|--------|
| Unit test suite | <5s | ~2s ✅ |
| Integration test suite | <10s | ~4s ✅ |
| Individual test | <100ms | <10ms ✅ |
| Encryption operation | <10ms | <1ms ✅ |

## Next Steps

1. **Phase 1.2**: Implement Claude agent tests
2. **Coverage**: Increase to 85%+
3. **E2E**: Automate WebSocket tests
4. **Load**: Add stress tests (1000+ concurrent users)

---

**Happy Testing!** 🧪

For detailed results, see: [TEST_SUITE_SUMMARY.md](../docs/TEST_SUITE_SUMMARY.md)
