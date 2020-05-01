import * as ethers from 'ethers'
import {
    PubKey,
    PrivKey,
    Keypair,
    Command,
    StateLeaf,
} from 'maci-domainobjs'

import { MaciState } from 'maci-core'
import {
    bigInt,
    genRandomSalt,
} from 'maci-crypto'

import {
    maciContractAbi,
    genTestAccounts,
} from 'maci-contracts'

import { genPubKey } from 'maci-crypto'

import { config } from 'maci-config'

import { exec, delay } from './utils'

import {
    maxUsers,
    maxMessages,
    maxVoteOptions,
    messageBatchSize,
    tallyBatchSize,
    initialVoiceCredits,
    stateTreeDepth,
    messageTreeDepth,
    voteOptionTreeDepth,
} from './params'

const loadData = (name: string) => {
    return require('@maci-integrationTests/ts/__tests__/suites/' + name)
}

const executeSuite = async (data: any, expect: any) => {
    console.log(data)
    const accounts = genTestAccounts(2)
    const userPrivKey = accounts[1].privateKey
    const coordinatorKeypair = new Keypair()
    const maciPrivkey = coordinatorKeypair.privKey.serialize()
    const deployerPrivKey = accounts[0].privateKey
    const providerUrl = config.get('chain.url')
    const provider = new ethers.providers.JsonRpcProvider(providerUrl)

    const deployerWallet = new ethers.Wallet(accounts[0].privateKey, provider)
    const tx = await deployerWallet.provider.sendTransaction(
        accounts[0].sign({
            nonce: await deployerWallet.provider.getTransactionCount(accounts[0].address),
            gasPrice: ethers.utils.parseUnits('10', 'gwei'),
            gasLimit: 21000,
            to: accounts[1].address,
            value: ethers.utils.parseUnits('1', 'ether'),
            data: '0x'
        })
    )
    await tx.wait()

    const maciState = new MaciState(
        coordinatorKeypair,
        stateTreeDepth,
        messageTreeDepth,
        voteOptionTreeDepth,
        maxVoteOptions,
    )

    const signupDuration = data.numUsers * 12
    const votingDuration = data.numUsers * 12

    // Run the create subcommand
    const createCommand = `node ../cli/build/index.js create` +
        ` -d ${deployerPrivKey} -sk ${maciPrivkey}` +
        ` -u ${maxUsers}` +
        ` -m ${maxMessages}` +
        ` -v ${maxVoteOptions}` +
        ` -e ${providerUrl}` +
        ` -s ${signupDuration}` +
        ` -o ${votingDuration}` +
        ` -bm ${messageBatchSize}` +
        ` -bv ${tallyBatchSize}` +
        ` -c ${initialVoiceCredits}`

    console.log(createCommand)

    const createOutput = exec(createCommand).stdout.trim()

    // Log the output for further manual testing
    console.log(createOutput)

    const regMatch = createOutput.match(/^MACI: (0x[a-fA-F0-9]{40})$/)
    const maciAddress = regMatch[1]
    
    const userKeypairs: Keypair[] = []

    console.log(`Signing up ${data.numUsers} users`)
    // Sign up
    for (let i = 0; i < data.numUsers; i++) {
        const userKeypair = new Keypair()
        userKeypairs.push(userKeypair)
        // Run the signup command
        const signupCommand = `node ../cli/build/index.js signup` +
            ` -p ${userKeypair.pubKey.serialize()}` +
            ` -d ${userPrivKey}` +
            ` -x ${maciAddress}`

        //console.log(signupCommand)

        const signupExec = exec(signupCommand)
        if (signupExec.stderr) {
            console.error(signupExec.stderr)
            return false
        }

        maciState.signUp(
            userKeypair.pubKey, 
            bigInt(initialVoiceCredits),
        )
    }

    const maciContract = new ethers.Contract(
        maciAddress,
        maciContractAbi,
        provider,
    )

    expect(maciState.genStateRoot().toString()).toEqual((await maciContract.getStateTreeRoot()).toString())

    const signUpTimestamp = await maciContract.signUpTimestamp()

    await delay(1000 * signupDuration)

    // Publish messages
    console.log(`Publishing messages`)

    for (let i = 0; i < data.commands.length; i++) {
        if (data.commands[i].user >= userKeypairs.length) {
            continue
        }

        const userKeypair = userKeypairs[data.commands[i].user]
        const stateIndex = i + 1
        const voteOptionIndex = data.commands[i].voteOptionIndex
        const newVoteWeight  = data.commands[i].voteWeight
        const nonce = data.commands[i].nonce
        const salt = '0x' + genRandomSalt().toString(16)
 
        // Run the publish command
        const publishCommand = `node ../cli/build/index.js publish` +
            ` -sk ${userKeypair.privKey.serialize()}` +
            ` -p ${userKeypair.pubKey.serialize()}` +
            ` -d ${userPrivKey}` +
            ` -x ${maciAddress}` +
            ` -i ${stateIndex}` +
            ` -v ${voteOptionIndex}` +
            ` -w ${newVoteWeight}` +
            ` -n ${nonce}` +
            ` -s ${salt}`

        //console.log(publishCommand)

        const publishExec = exec(publishCommand)
        if (publishExec.stderr) {
            console.log(publishExec.stderr)
            return false
        }

        const publishOutput = publishExec.stdout.trim()
        //console.log(publishOutput)

        const publishRegMatch = publishOutput.match(
            /Transaction hash: (0x[a-fA-F0-9]{64})\nEphemeral private key: (macisk.[a-f0-9]+)$/)

        // The publish command generates and outputs a random ephemeral private
        // key, so we have to retrieve it from the standard output
        const encPrivKey = PrivKey.unserialize(publishRegMatch[2])
        const encPubKey = new PubKey(genPubKey(encPrivKey.rawPrivKey))

        const command = new Command(
            bigInt(stateIndex),
            userKeypair.pubKey,
            bigInt(voteOptionIndex),
            bigInt(newVoteWeight),
            bigInt(nonce),
            bigInt(salt),
        )

        const signature = command.sign(userKeypair.privKey)

        const message = command.encrypt(
            signature,
            Keypair.genEcdhSharedKey(
                encPrivKey,
                coordinatorKeypair.pubKey,
            )
        )

        maciState.publishMessage(
            message,
            encPubKey,
        )
    }

    // Check whether the message tree root is correct
    expect(maciState.genMessageRoot().toString()).toEqual((await maciContract.getMessageTreeRoot()).toString())

    await delay(1000 * votingDuration)

    // Process messages
    const processCommand = `NODE_OPTIONS=--max-old-space-size=4096 node ../cli/build/index.js process` +
        ` -sk ${coordinatorKeypair.privKey.serialize()}` +
        ` -d ${userPrivKey}` +
        ` -x ${maciAddress}` +
        ` --repeat`

    console.log(processCommand)

    const e = exec(processCommand)

    console.log(e)

    const output = e.stdout.trim()

    // Check whether the transaction succeeded
    const processRegMatch = output.match(
        /Processed batch starting at index ([0-9]+)\nTransaction hash: (0x[a-fA-F0-9]{64})\nRandom state leaf: (.+)$/
    )

    expect(processRegMatch).toBeTruthy()

    // Check whether it has processed all batches
    const processedIndexNum = parseInt(processRegMatch[1], 10)
    const currentMessageBatchIndex = await maciContract.currentMessageBatchIndex()

    expect((processedIndexNum + messageBatchSize).toString()).toEqual(currentMessageBatchIndex.toString())

    const randomLeaf = StateLeaf.unserialize(processRegMatch[3])

    const tallyCommand = `NODE_OPTIONS=--max-old-space-size=4096 node ../cli/build/index.js tally` +
        ` -sk ${coordinatorKeypair.privKey.serialize()}` +
        ` -d ${userPrivKey}` +
        ` -x ${maciAddress}` +
        ` -z ${randomLeaf.serialize()}` +
        ` -c 0x0000000000000000000000000000000000000000000000000000000000000000` +
        ` -r`

    console.log(tallyCommand)

    const tallyOutput = exec(tallyCommand)

    if (tallyOutput.stderr) {
        console.log(tallyOutput.stderr)
    }

    console.log(tallyOutput.stdout)

    const tallyRegMatch = tallyOutput.match(
        /Transaction hash: (0x[a-fA-F0-9]{64})\nCurrent results salt: (0x[a-fA-F0-9]+)\n$/
    )

    expect(tallyRegMatch).toBeTruthy()

    const finalTallyTx = await provider.getTransaction(tallyRegMatch[1])

    const iface = new ethers.utils.Interface(maciContractAbi)

    const tallyTxData = ethers.utils.defaultAbiCoder.decode(
        iface.functions.proveVoteTallyBatch.inputs,
        ethers.utils.hexDataSlice(finalTallyTx.data, 4),
    )

    const finalTallyOnChain = tallyTxData._finalResults.map((x) => parseInt(x.toString(), 10))

    expect(JSON.stringify(finalTallyOnChain))
        .toEqual(JSON.stringify(data.expectedTally))

    return true
}

export {
    loadData,
    executeSuite,
}
