import { install } from 'undici';

// Bootstrap before application imports so provider and maintenance clients use
// the patched package together with its matching Request/Response classes.
// Installing the dependency alone leaves Node's bundled fetch unchanged.
install();
