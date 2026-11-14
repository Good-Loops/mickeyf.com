const notice = require('../../../shared/childDailyUsageNotice.json') as { version: string };
if (!/^child-daily-usage-consent-[A-Za-z0-9.-]{1,36}$/u.test(notice.version)) throw new Error('Invalid daily usage notice version.');
export const CHILD_DAILY_USAGE_NOTICE_VERSION = notice.version;
