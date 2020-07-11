"use strict";

const assert = require("assert");
const { Ipfs } = require("../dist/index");
const ethers = require("ethers");

describe("block get", function () {
  it("should return data", async function () {
    const data = await Ipfs.get(
      "Qmd2V777o5XvJbYMeMb8k2nU5f8d3ciUQ5YpYuWhzv8iDj"
    );
    console.log(ethers.utils.toUtf8String(data));
    assert.ok(data.length > 0, "hash has length");
  });
});
