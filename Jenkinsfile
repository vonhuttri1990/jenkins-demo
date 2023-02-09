pipeline {

    agent { label "maintenance" }

    triggers {
        cron('@daily')
    }

    // tools { nodejs 'nodejs' }

    stages {
        stage('Installing dependencies') {
            steps {
                script {
                    sh 'npm install'
                }
            }
        }

        stage('Update') {
            parallel {
                stage('Dev') { steps { script {
                            withCredentials([usernamePassword(credentialsId: 'aws-ecs-deploy-dev', passwordVariable: 'AWS_SECRET_ACCESS_KEY', usernameVariable: 'AWS_ACCESS_KEY_ID')]) {
                                sh 'npm start'
                            }
                }}}

            }
        }
    }
}
