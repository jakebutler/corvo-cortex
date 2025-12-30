import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger, LogLevel } from '../../../src/utils/logger';

describe('Logger Utility', () => {
    let logger: Logger;
    let mockConsole: any;

    beforeEach(() => {
        // Mock global console methods
        mockConsole = {
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            log: vi.fn()
        };
        vi.stubGlobal('console', mockConsole);

        // Re-import Logger to ensure it uses the stubbed console if it captures it (it doesn't, it uses global console at runtime)
        logger = new Logger({ appId: 'test' });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('should log info messages with context', () => {
        logger.info('test message', { foo: 'bar' });

        expect(mockConsole.info).toHaveBeenCalledTimes(1);
        const logData = JSON.parse(mockConsole.info.mock.calls[0][0]);

        expect(logData.level).toBe(LogLevel.INFO);
        expect(logData.message).toBe('test message');
        expect(logData.context).toEqual({ appId: 'test', foo: 'bar' });
        expect(logData.timestamp).toBeDefined();
    });

    it('should log error messages with Error object', () => {
        const error = new Error('test error');
        logger.error('failed operation', error, { requestId: '123' });

        expect(mockConsole.error).toHaveBeenCalledTimes(1);
        const logData = JSON.parse(mockConsole.error.mock.calls[0][0]);

        expect(logData.level).toBe(LogLevel.ERROR);
        expect(logData.message).toBe('failed operation');
        expect(logData.context).toEqual({ appId: 'test', requestId: '123' });
        expect(logData.error).toEqual({
            name: 'Error',
            message: 'test error',
            stack: expect.any(String)
        });
    });

    it('should create new logger with merged context', () => {
        const childLogger = logger.withContext({ component: 'child' });
        childLogger.debug('child message');

        expect(mockConsole.debug).toHaveBeenCalled();
        const logData = JSON.parse(mockConsole.debug.mock.calls[0][0]);

        expect(logData.context).toEqual({ appId: 'test', component: 'child' });
    });
});
