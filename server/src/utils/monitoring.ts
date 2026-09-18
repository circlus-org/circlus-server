import os from 'os';
import { execSync } from 'child_process';
import { getPool } from '../db';
import { identityRepository, deviceRepository, inviteRepository, callSessionRepository } from '../db/repositories';
import type {
  ServerHealthMetrics,
  ResourceUsage,
  DatabaseMetrics,
  ApplicationMetrics,
  ResourceStatus
} from '../../../shared/types';
import { getRequestLogger } from '../middleware/requestContext';

/**
 * Determine resource status based on percentage
 */
function getResourceStatus(percentage: number, warningThreshold: number = 70, criticalThreshold: number = 85): ResourceStatus {
  if (percentage >= criticalThreshold) return 'critical';
  if (percentage >= warningThreshold) return 'warning';
  return 'healthy';
}

/**
 * Get CPU usage
 */
function getCpuUsage(): ResourceUsage {
  const cpus = os.cpus();
  let totalIdle = 0;
  let totalTick = 0;

  cpus.forEach(cpu => {
    for (const type in cpu.times) {
      totalTick += cpu.times[type as keyof typeof cpu.times];
    }
    totalIdle += cpu.times.idle;
  });

  const idle = totalIdle / cpus.length;
  const total = totalTick / cpus.length;
  const usage = 100 - ~~(100 * idle / total);

  return {
    used: usage,
    total: 100,
    percentage: usage,
    status: getResourceStatus(usage)
  };
}

/**
 * Get memory usage
 */
function getMemoryUsage(): ResourceUsage {
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = totalMemory - freeMemory;
  const percentage = (usedMemory / totalMemory) * 100;

  return {
    used: usedMemory,
    total: totalMemory,
    percentage,
    status: getResourceStatus(percentage)
  };
}

/**
 * Get disk usage (optional, requires df command)
 */
function getDiskUsage(): ResourceUsage | undefined {
  try {
    // Try to get disk usage using df command
    const output = execSync('df -k / | tail -1').toString();
    const parts = output.split(/\s+/);

    if (parts.length >= 5) {
      const total = parseInt(parts[1], 10) * 1024; // Convert KB to bytes
      const used = parseInt(parts[2], 10) * 1024;
      const percentage = parseFloat(parts[4].replace('%', ''));

      return {
        used,
        total,
        percentage,
        status: getResourceStatus(percentage, 80, 90) // Stricter thresholds for disk
      };
    }
  } catch (error) {
    // df command not available or failed, skip disk metrics
    getRequestLogger({ subsystem: 'monitoring' }).warn('disk_usage_unavailable', { error });
  }

  return undefined;
}

/**
 * Get database connection pool metrics
 */
async function getDatabaseMetrics(): Promise<DatabaseMetrics> {
  const pool = getPool();

  // Get pool stats
  const totalConnections = pool.totalCount;
  const idleConnections = pool.idleCount;
  const waitingConnections = pool.waitingCount;

  // Get max connections from config
  const maxConnections = (pool as any).options?.max || 10;

  // Calculate active connections
  const activeConnections = totalConnections - idleConnections;

  // Calculate pool utilization percentage
  const poolUtilization = (totalConnections / maxConnections) * 100;

  // Query database for actual connection count (more accurate)
  let dbActiveConnections = activeConnections;
  try {
    const result = await pool.query<{ count: string }>(
      "SELECT count(*) as count FROM pg_stat_activity WHERE datname = current_database();"
    );
    dbActiveConnections = parseInt(result.rows[0]?.count || '0', 10);
  } catch (error) {
    getRequestLogger({ subsystem: 'monitoring' }).warn('database_connection_metrics_unavailable', { error });
  }

  return {
    totalConnections,
    idleConnections,
    activeConnections: dbActiveConnections,
    waitingConnections,
    maxConnections,
    poolUtilization,
    status: getResourceStatus(poolUtilization, 60, 80) // Connection pool thresholds
  };
}

/**
 * Get application metrics
 */
async function getApplicationMetrics(familyId: string): Promise<ApplicationMetrics> {
  // Count total users
  const totalUsers = await identityRepository.count(familyId);

  // Count active devices (devices seen in last 24 hours)
  const onlineThreshold = new Date();
  onlineThreshold.setHours(onlineThreshold.getHours() - 24);
  const activeDevices = await deviceRepository.countActiveSince(familyId, onlineThreshold);

  // Count online devices (devices seen in last 5 minutes)
  const onlineDevicesThreshold = new Date();
  onlineDevicesThreshold.setMinutes(onlineDevicesThreshold.getMinutes() - 5);
  const onlineDevices = await deviceRepository.countActiveSince(familyId, onlineDevicesThreshold);

  // Count active calls
  const activeCalls = await callSessionRepository.countActiveCalls(familyId);

  // Count invites
  const totalInvites = await inviteRepository.count(familyId);
  const activeInvites = await inviteRepository.countActive(familyId);

  return {
    totalUsers,
    activeDevices,
    onlineDevices,
    activeCalls,
    totalInvites,
    activeInvites
  };
}

/**
 * Generate recommendations based on metrics
 */
function generateRecommendations(metrics: Omit<ServerHealthMetrics, 'recommendations' | 'overallStatus'>): string[] {
  const recommendations: string[] = [];

  // Memory recommendations
  if (metrics.memory.status === 'critical') {
    recommendations.push('MEMORY_USAGE_CRITICAL');
  } else if (metrics.memory.status === 'warning') {
    recommendations.push('MEMORY_USAGE_WARNING');
  }

  // CPU recommendations
  if (metrics.cpu.status === 'critical') {
    recommendations.push('CPU_USAGE_CRITICAL');
  } else if (metrics.cpu.status === 'warning') {
    recommendations.push('CPU_USAGE_WARNING');
  }

  // Disk recommendations
  if (metrics.disk) {
    if (metrics.disk.status === 'critical') {
      recommendations.push('DISK_USAGE_CRITICAL');
    } else if (metrics.disk.status === 'warning') {
      recommendations.push('DISK_USAGE_WARNING');
    }
  }

  // Database connection pool recommendations
  if (metrics.database.status === 'critical') {
    recommendations.push('DATABASE_POOL_USAGE_CRITICAL');
  } else if (metrics.database.status === 'warning') {
    recommendations.push('DATABASE_POOL_USAGE_WARNING');
  }

  // Resource-based scaling recommendations
  // Check if resources are under stress AND there's significant load
  const hasResourceStress =
    metrics.cpu.percentage > 60 ||
    metrics.memory.percentage > 60 ||
    metrics.database.poolUtilization > 50;

  const hasSignificantLoad =
    metrics.application.onlineDevices > 5 ||
    metrics.application.activeCalls > 0;

  if (hasResourceStress && hasSignificantLoad) {
    // Analyze what's causing the stress
    const stressFactors: string[] = [];

    if (metrics.cpu.percentage > 60) {
      stressFactors.push('CPU');
    }
    if (metrics.memory.percentage > 60) {
      stressFactors.push('MEMORY');
    }
    if (metrics.database.poolUtilization > 50) {
      stressFactors.push('DATABASE');
    }

    recommendations.push(`RESOURCE_PRESSURE:${stressFactors.join(',')}`);
  }

  // Positive feedback when resources are sufficient
  if (recommendations.length === 0) {
    recommendations.push('RESOURCES_HEALTHY');
  }

  return recommendations;
}

/**
 * Get overall system status
 */
function getOverallStatus(
  cpu: ResourceUsage,
  memory: ResourceUsage,
  disk: ResourceUsage | undefined,
  database: DatabaseMetrics
): ResourceStatus {
  const statuses = [cpu.status, memory.status, database.status];
  if (disk) statuses.push(disk.status);

  // If any critical - overall is critical
  if (statuses.includes('critical')) return 'critical';

  // If any warning - overall is warning
  if (statuses.includes('warning')) return 'warning';

  // All healthy
  return 'healthy';
}

/**
 * Collect all server health metrics
 */
export async function collectServerHealthMetrics(familyId: string): Promise<ServerHealthMetrics> {
  const cpu = getCpuUsage();
  const memory = getMemoryUsage();
  const disk = getDiskUsage();
  const database = await getDatabaseMetrics();
  const application = await getApplicationMetrics(familyId);

  const metricsWithoutRecommendations = {
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    cpu,
    memory,
    disk,
    database,
    application
  };

  const overallStatus = getOverallStatus(cpu, memory, disk, database);
  const recommendations = generateRecommendations(metricsWithoutRecommendations);

  return {
    ...metricsWithoutRecommendations,
    overallStatus,
    recommendations
  };
}
