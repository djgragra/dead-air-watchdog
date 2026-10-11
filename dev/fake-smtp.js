// A tiny SMTP server for tests: records every message (envelope + text) and can refuse the sender.
import net from 'node:net';

export async function startFakeSmtp({ refuse = false } = {}) {
  const messages = [];
  const server = net.createServer((sock) => {
    sock.write('220 test ESMTP\r\n');
    let cur = null;
    let inData = false;
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push(cur);
            sock.write('250 queued\r\n');
          } else cur.data += line + '\n';
          continue;
        }
        if (/^EHLO/i.test(line)) sock.write('250-test\r\n250 8BITMIME\r\n');
        else if (/^MAIL FROM/i.test(line)) {
          if (refuse) sock.write('550 refused\r\n');
          else {
            cur = { from: line.slice(10), to: [], data: '' };
            sock.write('250 ok\r\n');
          }
        } else if (/^RCPT TO/i.test(line)) {
          cur.to.push(line.slice(8).replace(/[<>]/g, ''));
          sock.write('250 ok\r\n');
        } else if (/^DATA/i.test(line)) {
          inData = true;
          sock.write('354 go\r\n');
        } else if (/^QUIT/i.test(line)) sock.end('221 bye\r\n');
        else sock.write('250 ok\r\n');
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, messages, close: () => new Promise((r) => server.close(r)) };
}
