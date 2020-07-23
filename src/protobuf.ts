"use strict";

import { ethers } from "ethers";
import { getUrl } from "./geturl";
import { BaseX } from "@ethersproject/basex";
import { Varint } from "./varint";
import { getBoundary } from "./boundary";

const INFURA_IPFS_URL = "https://ipfs.infura.io:5001/api/v0/block";

const base58 = new BaseX(
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
);

// UnixFs data type
enum UnixFsType {
  Raw = 0,
  Directory = 1,
  File = 2,
  Metadata = 3,
  Symlink = 4,
  HAMTShard = 5,
}

// https://developers.google.com/protocol-buffers/docs/encoding
enum WireType {
  Varint = 0,
  Fixed64 = 1,
  VarLength = 2,
}

enum SchemaType {
  PBNODE = 1,
  PBLINK = 2,
  UNIXFS = 3,
}

// Protobuf definitions for merkledag node and links:
// https://github.com/ipld/js-ipld-dag-pb/blob/master/src/dag.proto.js
//    https://github.com/ipfs/go-merkledag/blob/master/pb/merkledag.proto
// Protobuf defintions for unixfs:
//    https://github.com/ipfs/go-unixfs/blob/master/pb/unixfs.proto

type SchemaDefinition = {
  names: Array<string>;
  types: Array<number>;
  repeated?: { [key: string]: boolean };
};

const Schemas: { [name: string]: SchemaDefinition } = {
  [SchemaType.PBNODE]: {
    names: ["data", "links"],
    types: [WireType.Varint, WireType.VarLength],
    repeated: { links: true },
  },
  [SchemaType.PBLINK]: {
    names: ["hash", "name", "tsize"],
    types: [WireType.VarLength, WireType.VarLength, WireType.Varint],
  },
  [SchemaType.UNIXFS]: {
    names: ["type", "data", "filesize", "blocksize", "hashtype", "fanout"],
    types: [
      WireType.Varint,
      WireType.VarLength,
      WireType.Varint,
      WireType.Varint,
      WireType.Varint,
      WireType.Varint,
    ],
  },
};

class PBNode {
  static encode(data?: Uint8Array): Uint8Array {
    const schema: SchemaDefinition = Schemas[SchemaType.PBNODE];
    const result: Array<Uint8Array> = [];

    if (data) {
      // tag, length of unixfs encoded data, unixfs encoded data
      const tag = schema.names.findIndex((i) => i === "data") + 1;
      const encodedTag = Varint.encode((tag << 3) + WireType.VarLength);
      result.push(encodedTag);

      const encodedData = PBData.encode(data);
      const size = Varint.encode(encodedData.byteLength);
      result.push(size);
      result.push(encodedData);
    }
    return ethers.utils.concat(result);
  }

  static parse(data: Uint8Array): Promise<Uint8Array> {
    const schema: SchemaDefinition = Schemas[SchemaType.PBNODE];
    const result = ProtoBuf.parse(data, schema);

    if (result.links) {
      var promises: Array<Promise<Uint8Array>> = [];
      result.links.forEach(function (hash: Uint8Array) {
        promises.push(PBLink.parse(hash));
      });
      return Promise.all(promises).then(function (blocks) {
        return ethers.utils.concat(blocks);
      });
    }
    if (result.data && result.data.constructor === Uint8Array) {
      return Promise.resolve(PBData.parse(result.data));
    }

    throw new Error("Missing links or data");
  }
}

class PBLink {
  static parse(data: Uint8Array): Promise<Uint8Array> {
    const schema: SchemaDefinition = Schemas[SchemaType.PBLINK];
    const result = ProtoBuf.parse(data, schema);
    if (result.hash.length !== 34) {
      throw new Error(`unsupported hash ${ethers.utils.hexlify(result.hash)}`);
    }
    return ProtoBuf.get(base58.encode(result.hash));
  }
}

class PBData {
  static encode(data: Uint8Array): Uint8Array {
    const schema: SchemaDefinition = Schemas[SchemaType.UNIXFS];
    const result: Array<Uint8Array> = [];

    let tag = schema.names.findIndex((i) => i === "type") + 1;
    let encodedTag = Varint.encode((tag << 3) + WireType.Varint);
    const type = Varint.encode(UnixFsType.File);
    result.push(encodedTag);
    result.push(type);

    tag = schema.names.findIndex((i) => i === "data") + 1;
    encodedTag = Varint.encode((tag << 3) + WireType.VarLength);
    const size = Varint.encode(data.byteLength);
    result.push(encodedTag);
    result.push(size);
    result.push(data);

    tag = schema.names.findIndex((i) => i === "filesize") + 1;
    encodedTag = Varint.encode((tag << 3) + WireType.Varint);
    result.push(encodedTag);
    result.push(size);

    return ethers.utils.concat(result);
  }

  static parse(data: Uint8Array): Promise<Uint8Array> {
    const schema: SchemaDefinition = Schemas[SchemaType.UNIXFS];
    const result = ProtoBuf.parse(data, schema);

    if (result.type !== UnixFsType.File) {
      throw new Error("unsupported type");
    }
    if (!result.data) {
      return Promise.resolve(new Uint8Array([]));
    }
    if (result.data.constructor !== Uint8Array) {
      throw new Error("bad Data");
    }
    return Promise.resolve(result.data);
  }
}

export class ProtoBuf {
  /*
   * get from ipfs by multihash
   */
  static get(multihash: string): Promise<Uint8Array> {
    const url = `${INFURA_IPFS_URL}/get?arg=${multihash}`;

    return getUrl(url).then((res) => {
      const hash = ethers.utils.sha256(res.body);
      const hashFromCID = ethers.utils.hexlify(
        base58.decode(multihash).slice(2)
      );
      if (hash !== hashFromCID) {
        throw new Error("hash mismatch");
      }
      return PBNode.parse(res.body);
    });
  }

  /*
   * put file ipfs
   */
  static put(data: Uint8Array): Promise<any> {
    const url = `${INFURA_IPFS_URL}/put`;

    const boundary = getBoundary();
    let body = "";
    body += "--" + boundary + "\r\n";
    body += "Content-Type:application/octet-stream\r\n\r\n";
    var payload = Buffer.concat([
      Buffer.from(body, "utf8"),
      Buffer.from(PBNode.encode(data)),
      Buffer.from("\r\n--" + boundary + "--\r\n", "utf8"),
    ]);
    const options = {
      method: "POST",
      body: payload,
      headers: { "Content-Type": "multipart/form-data; boundary=" + boundary },
    };
    return getUrl(url, options).then((res) => {
      return JSON.parse(ethers.utils.toUtf8String(res.body));
    });
  }

  static parse(data: Uint8Array, schema: SchemaDefinition): any {
    let tempResult: { [key: string]: Array<any> } = {};
    let result: { [key: string]: any } = {};
    let offset = 0;

    while (offset < data.length) {
      let varint = Varint.decode(data, offset);
      const v = varint.value;
      offset += varint.length;
      const tag = schema.names[(v >>> 3) - 1];

      if (!tag) {
        console.log("data", data, ethers.utils.toUtf8String(data));
        throw new Error("unknown field - " + v);
      }

      if (!tempResult[tag]) {
        tempResult[tag] = [];
      }
      // now get the wire type from v
      switch (v & 7) {
        // varint
        case WireType.Varint:
          varint = Varint.decode(data, offset);
          tempResult[tag].push(varint.value);
          offset += varint.length;
          break;

        // bytes
        case WireType.VarLength: {
          varint = Varint.decode(data, offset);
          const length = varint.value;
          if (offset + length > data.length) {
            throw new Error("buffer overrun");
          }
          offset += varint.length;

          tempResult[tag].push(data.slice(offset, offset + length));
          offset += length;
          break;
        }

        default:
          console.log("unsupported type - " + tag);
          throw new Error("unsupported type - " + tag);
      }
    }

    Object.keys(tempResult).forEach((key: string) => {
      result[key] =
        schema.repeated && schema.repeated[key]
          ? tempResult[key]
          : tempResult[key][0];
    });
    return result;
  }
}
