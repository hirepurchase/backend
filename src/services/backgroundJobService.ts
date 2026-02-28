const activeJobs = new Set<string>();

export function isJobRunning(jobName: string): boolean {
  return activeJobs.has(jobName);
}

export function enqueueSingletonJob(jobName: string, task: () => Promise<void>): boolean {
  if (activeJobs.has(jobName)) {
    return false;
  }

  activeJobs.add(jobName);

  setImmediate(async () => {
    try {
      await task();
    } finally {
      activeJobs.delete(jobName);
    }
  });

  return true;
}

