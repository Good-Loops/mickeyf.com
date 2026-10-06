import { runReceiptMaintenance } from './receiptMaintenanceOperations';

// This file is a dedicated Cloud Run Job entrypoint, never imported by the API.
// Exit after bounded shutdown even if a failed driver session still owns handles.
void runReceiptMaintenance().then((code) => process.exit(code), () => process.exit(1));
