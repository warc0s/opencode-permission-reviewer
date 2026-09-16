/** Host-independent reads used to recover actor identity and intent. */
export interface ContextReader {
  messages(sessionID: string, directory: string, limit: number): Promise<unknown>
  session(sessionID: string, directory: string): Promise<unknown>
}
