import { describe, expect, it } from 'vitest';
import { amzDateOf, authorization, canonicalQuery, EMPTY_SHA256, parseAuthorization, sha256Hex, uriEncode, type SignInput } from './sigv4';

/**
 * AWS Signature Version 4 against the vectors AWS publishes: the four examples of the S3 documentation
 * ("Signature Calculations for the Authorization Header", examplebucket, 24 May 2013) and two of the
 * general SigV4 test suite (get-vanilla and get-vanilla-query-order-key-case, 30 August 2015). The keys
 * are AWS's published example keys, not anyone's.
 */

const S3_DOC_KEYS = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
const SUITE_KEYS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
const S3_DATE = '20130524T000000Z';

function s3Doc(o: Pick<SignInput, 'method' | 'path' | 'query' | 'payloadHash'> & { headers: Record<string, string> }): SignInput {
  return {
    ...o,
    headers: { host: 'examplebucket.s3.amazonaws.com', 'x-amz-date': S3_DATE, 'x-amz-content-sha256': o.payloadHash, ...o.headers },
    region: 'us-east-1', service: 's3', credentials: S3_DOC_KEYS, amzDate: S3_DATE,
  };
}

describe('SigV4: the S3 documentation examples', () => {
  it('GET Object (a range)', () => {
    const a = authorization(s3Doc({ method: 'GET', path: '/test.txt', payloadHash: EMPTY_SHA256, headers: { range: 'bytes=0-9' } }));
    expect(a.signedHeaders).toBe('host;range;x-amz-content-sha256;x-amz-date');
    expect(a.signature).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
    expect(a.header).toBe('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });

  it('PUT Object (a key with a $, a payload, a storage class and a Date)', () => {
    const payloadHash = sha256Hex('Welcome to Amazon S3.');
    expect(payloadHash).toBe('44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
    const a = authorization(s3Doc({
      method: 'PUT', path: `/${uriEncode('test$file.text', true)}`, payloadHash,
      headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
    }));
    expect(a.signedHeaders).toBe('date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class');
    expect(a.signature).toBe('98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
  });

  it('GET Bucket Lifecycle (a parameter with no value)', () => {
    const a = authorization(s3Doc({ method: 'GET', path: '/', query: [['lifecycle', '']], payloadHash: EMPTY_SHA256, headers: {} }));
    expect(a.signature).toBe('fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543');
  });

  it('GET Bucket (List Objects: parameters sorted)', () => {
    const a = authorization(s3Doc({ method: 'GET', path: '/', query: [['prefix', 'J'], ['max-keys', '2']], payloadHash: EMPTY_SHA256, headers: {} }));
    expect(a.signature).toBe('34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
  });
});

describe('SigV4: the general test suite', () => {
  const suite = (query: SignInput['query']): SignInput => ({
    method: 'GET', path: '/', query, headers: { Host: 'example.amazonaws.com', 'X-Amz-Date': '20150830T123600Z' },
    payloadHash: EMPTY_SHA256, region: 'us-east-1', service: 'service', credentials: SUITE_KEYS, amzDate: '20150830T123600Z',
  });

  it('get-vanilla', () => {
    expect(authorization(suite([])).header).toBe('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  });

  it('get-vanilla-query-order-key-case', () => {
    expect(authorization(suite([['Param2', 'value2'], ['Param1', 'value1']])).signature).toBe('b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500');
  });
});

describe('SigV4: the pieces', () => {
  it('encodes as RFC 3986 asks, keeping a slash only in a path', () => {
    expect(uriEncode('a b/c~d*e')).toBe('a%20b%2Fc~d%2Ae');
    expect(uriEncode('calls/CA1/x.jsonl', true)).toBe('calls/CA1/x.jsonl');
    expect(uriEncode('é')).toBe('%C3%A9');
    expect(canonicalQuery([['list-type', '2'], ['continuation-token', 'a/b='], ['prefix', 'p/']])).toBe('continuation-token=a%2Fb%3D&list-type=2&prefix=p%2F');
  });

  it('says the time as x-amz-date does', () => {
    expect(amzDateOf(Date.UTC(2013, 4, 24, 0, 0, 0, 123))).toBe('20130524T000000Z');
  });

  it('reads an Authorization header back, and nothing else', () => {
    const a = authorization(suite0());
    expect(parseAuthorization(a.header)).toEqual({ accessKeyId: 'AKIDEXAMPLE', scope: '20150830/us-east-1/service/aws4_request', signedHeaders: ['host', 'x-amz-date'], signature: a.signature });
    expect(parseAuthorization('Basic dXNlcjpwYXNz')).toBeNull();
  });

  function suite0(): SignInput {
    return {
      method: 'GET', path: '/', headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' },
      payloadHash: EMPTY_SHA256, region: 'us-east-1', service: 'service', credentials: SUITE_KEYS, amzDate: '20150830T123600Z',
    };
  }
});
