#!/usr/bin/env zx
$.verbose = false

// Properties, Constants
const WAITING  = {
    doubleCheck: 300,
    aMinute: 60 
}

const STATUS = {
    active: "ACTIVE",
    draining: "DRAINING"
}

const log = console.log;

// Run main()
main()

async function main() {
    let clusters = await ecsListClusters()
    let instances = []
    for (const cluster of clusters) {
        let po = await $`aws ecs list-container-instances --cluster ${cluster}`
        if(po.exitCode == 0) {
            let poInstances = po.stdout
            let values = parseToArray(poInstances)
            for (const containerInstance of values) {

                let instance = await theInstanceNeedTerminate(cluster, containerInstance)
                if(instance) {
                    instances.push({'cluster': cluster ,'id':instance.ec2InstanceId, 'status': instance.status, 'containerInstanceARN':containerInstance})
                }
            }
        }
    }

    await processInstances(instances)
    log(chalk.blue("Done!"))

}

/**
 * Describes one or more container instances.
 * @return {Object} metadata about each container instance requested.
 * @param {String} containerInstance  - the full ARN of container instance.
 * @param {String} cluster - the full ARN of cluster.
 */
async function ecsDescribeContainer(cluster, containerInstance) {
    let po = await $`aws ecs describe-container-instances --cluster ${cluster} --container-instances ${containerInstance}`
    return parseToArray(po.stdout)
}

/**
 * Return a list of tasks of container instance.
 * @return {Promise<Array>} a list of tasks of container instance.
 * @param {String} containerInstance  - the full ARN of container instance.
 * @param {String} cluster - the full ARN of cluster.
 */
async function ecsListTasks(containerInstance, cluster) {
    let po = await $`aws ecs list-tasks --cluster ${cluster} --container-instance ${containerInstance}`
    if(po.exitCode != 0) {
        return 
    } else {
        let listTasks = parseToArray(po.stdout)
        return listTasks
    }
}


/**
 * Get the list of existing clusters.
 * @return {[String]} - Returns a list full ARN for each cluster.
 */
async function ecsListClusters() {
    let po =  await $`aws ecs list-clusters`
    log(`Getting the list of existing clusters.`)
    if(po.exitCode == 0) {
        let clustersArns = po.stdout
        // let clusters = JSON.parse(clustersArns)
        let values = parseToArray(clustersArns)
        return values
    }
    return 
}

/**
 * Get describe an instance.
 * @return {Object} - Describe info an instance
 * @param {String} id - ID of instance
 */
async function describeInstances(id) {
    let po = await $`aws ec2 describe-instances --instance-ids ${id}`
    /*
    {
        "Reservations": [
            {
                "Groups": [],
                "Instances": [
                    {
                        "AmiLaunchIndex": 0,
                        "InstanceId": "i-05b8bd49b711a3272",
                        "InstanceLifecycle": "spot",
                        "Tags": [
                            {
                            "Key": "aws:ec2spot:fleet-request-id",
                            "Value": "sfr-e9e7b568-fb42-4d98-98d4-c5e06e322dde"
                            }
                        ]
                    ],
                        ..
                    }
                ]
            }
        ]
    }
    */
    if (po.exitCode == 0) {
        let stdReservations = po.stdout
        let reservations = parseToArray(stdReservations)
        // log(reservations)
        let instanceArray = reservations[0].Instances
        let instance = instanceArray[0]
        return instance
    }
    return null
}

async function processInstances(instances) {
    if(instances.length == 0) {
        log(chalk.blue.bold("Can not find 'Instance' to terminate"))
    }

    for (const instance of instances) {
        log(chalk.green(`Processing instance ID: "${instance.id}" of Cluster: "${instance.cluster}"`))
        let describe = await describeInstances(instance.id)
        // If instance is type Spot
        //  - Step 1: Check instance in Spot requests
        if(describe.InstanceLifecycle === 'spot') {
            let spotFleetRequest = describe.Tags
            let spotFleetID = spotFleetRequest[0].Value
            let po = await $`aws ec2 describe-spot-fleet-requests --spot-fleet-request-ids ${spotFleetID}`
            let spotFleetArray = parseToArray(po.stdout)
            let spotFleetConfig = spotFleetArray[0].SpotFleetRequestConfig
            let currentTargetCapacity = spotFleetConfig.TargetCapacity

            if(instance.status === STATUS.active) {
                // sleep 5mins
                await $`sleep ${WAITING.doubleCheck}`
                let ci = await theInstanceNeedTerminate(instance.cluster, instance.containerInstanceARN)
                if (ci) {
                    if(updateStatusContainerInstance(instance, STATUS.draining)) {
                        log(chalk.blue(`Change status instance ${instance.id} from ${instance.status} to ${STATUS.draining}`))
                    } else {
                        log(chalk.red(`Can't change status to ${STATUS.draining} of ${instance.id}`))
                    }
                }
                await $`sleep ${WAITING.aMinute}`

            }
        
        //  - Step 2: Modify target capacity (decrement -1 in new target capacity not check "terminate instance")
            try {
                let result = await modifySpotFleet(currentTargetCapacity - 1, spotFleetID)
                if(result) {
                    log(chalk.green(`Cluster: ${instance.cluster}. Modify request received. Requested targetCapacity: ${currentTargetCapacity - 1}, excessCapacityTerminationPolicy: NoTermination`))
                }
            } catch (error) {
                log(chalk.red(error))
            }
            
            // Wait 60s after terminate instance
            await $`sleep ${WAITING.aMinute}` 

            
        //  - Step 3: Manual terminate instance
            let newStatus = await getStatusContainerInstance(instance.cluster, instance.containerInstanceARN)
            if (newStatus === STATUS.draining) {
                terminate(instance)
            }
                            
        } else {
        // If instance is type "auto scaling group"
        //  - Step 1: Check instance in Auto Scaling Group
            let tags = describe.Tags
            let autoScalingGroup 
            for (const tag  of tags) {
                if(tag.Key === 'aws:autoscaling:groupName') {
                    autoScalingGroup = tag.Value
                }
            }

            if(instance.status === STATUS.active) {
                // sleep 2mins
                await $`sleep ${WAITING.doubleCheck}`
                let ci = await theInstanceNeedTerminate(instance.cluster, instance.containerInstanceARN)
                if (ci) {
                    updateStatusContainerInstance(instance, STATUS.draining)
                    log(chalk.green(`Change status instance ${instance.id} from ${instance.status} to ${STATUS.draining}`))
                }

                await $`sleep ${WAITING.aMinute}`

            }

        //  - Step 2: Detach instance
            let poAuto = await autoscalingDetachInstances(instance.id, autoScalingGroup)
            
        //  - Step 3: Manual terminate instance
        await $`sleep ${WAITING.aMinute}`
        let newStatus = await getStatusContainerInstance(instance.cluster, instance.containerInstanceARN)
        if (newStatus === STATUS.draining) {
            terminate(instance)
        }
        }
    }
} 


/**
 * Modifies the specified Spot Fleet request.
 * @return {boolean} if the requested succeed, the response return "true"
 * @param {int} capacity - the size of the fleet want modify.
 * @param {String} spotFleetID - the ID of the Spot Fleet request.
 */
async function modifySpotFleet(capacity, spotFleetID) {
    let po = await $`aws ec2 modify-spot-fleet-request --excess-capacity-termination-policy noTermination --target-capacity ${capacity} --spot-fleet-request-id ${spotFleetID}`
    let result = parseToArray(po.stdout)
    return result
}   

/**
 * Shutdown the specified instance.
 *  @param {String} instance - id of ec2
 */
async function terminate(instance) {
    let po = await $`aws ec2 terminate-instances --instance-ids ${instance.id}`
    log(chalk.green.bold(`Terminate instance id: ${instance.id} ${po.exitCode == 0 ?  "SUCCESS" : "FAILURE"} in cluster: ${instance.cluster}`))
}


/**
 * Check that the container instance meets the conditions to be put in the list and proceed to terminate.
 * @return {Object} describe of container instance.
 * @param {String} cluster - This is the full ARN of cluster.
 * @param {String} containerInstance - This is the full ARN of container instance.
 */
async function theInstanceNeedTerminate(cluster, containerInstance) {
    let describe = await ecsDescribeContainer(cluster, containerInstance)
    let listTasks = await ecsListTasks(containerInstance, cluster)
    if(describe[0].runningTasksCount == 0 && describe[0].pendingTasksCount == 0 && listTasks.length == 0) {
        return describe[0]
    } else {
        return null
    }
     
}

/**
 * Get the status of container instance.
 * @return {String} status of a container instance.
 * @param {String} cluster - This is the full ARN of cluster.
 * @param {String} containerInstance - This is the full ARN of container instance.
 */
async function getStatusContainerInstance(cluster, containerInstance) {
    let describe = await ecsDescribeContainer(cluster, containerInstance)
    return describe[0].status
}

// 
/**
 * Modifies the status of a container instance 
 * @param {{cluster: String, id: String, status: String, containerInstanceARN: String}} instance - this is object of instance.
 * @param {String} status - this is the status you want modify
 * @return {Boolean} - return True if modify success
 */
async function updateStatusContainerInstance(instance, status) {
    let po = await $`aws ecs update-container-instances-state \
                    --cluster ${instance.cluster} \
                    --container-instances ${instance.containerInstanceARN} \
                    --status ${status}
                    `
    if(po.exitCode == 0) {
        return true
    }

    return false
}

// Detach EC2 instance from Auto Scaling Group
/**
 * @return {TYPE} description
 */
async function autoscalingDetachInstances(id, asgName) {
    let po = await $`aws autoscaling detach-instances \
                    --instance-ids ${id} \
                    --auto-scaling-group-name ${asgName} \
                    --should-decrement-desired-capacity 
    `
    return po.stdout
}

function parseToArray(obj) {
    let arr = JSON.parse(obj)
    let values = Object.values(arr)
    return values[0]
}

/**
 * descriptioádsdnsdasdfcsadfsdfds
 */
// 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
// 


